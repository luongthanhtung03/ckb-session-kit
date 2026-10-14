//! session-lock — a CKB lock script for browser-held session keys.
//!
//! A cell under this lock can be spent two ways:
//!
//! * **Owner mode.** The transaction also consumes a cell locked by the owner's
//!   lock. Anything is allowed: revoke, sweep, top up.
//! * **Session mode.** The transaction also consumes a cell locked by the
//!   session key's lock. The spend must stay inside the scope in the args.
//!
//! Signatures are *delegated*, not verified here: if an input locked by
//! `owner_lock_hash` is in the transaction, that lock already ran and verified
//! the owner's signature over the whole transaction. The same holds for the
//! session key. This is the pattern sUDT's owner mode uses, and it keeps this
//! script free of cryptography.
//!
//! Args (80 or 112 bytes; a token session, 128 or 160):
//!
//! | bytes  | field               | meaning                                          |
//! |--------|---------------------|--------------------------------------------------|
//! | 0..32  | owner_lock_hash     | lock hash whose presence grants owner mode       |
//! | 32..64 | session_lock_hash   | lock hash whose presence grants session mode     |
//! | 64..72 | max_per_tx (u64 LE) | most shannons one session spend may move out     |
//! | 72..80 | min_interval (u64)  | blocks each session-locked input must have aged  |
//! | 80..112| recipient_lock_hash | optional: the only lock session spends may pay   |
//!
//! A token session (xUDT, RFC 0052) puts the token between the CKB limits and
//! the recipient:
//!
//! | bytes   | field                    | meaning                                     |
//! |---------|--------------------------|---------------------------------------------|
//! | 80..112 | token_type_hash          | the one type script this session may hold   |
//! | 112..128| max_per_tx_token (u128)  | most token units one session spend may move |
//! | 128..160| recipient_lock_hash      | optional, as above                          |
//!
//! Session-mode rules:
//!
//! 1. **Outflow.** Capacity of this group's inputs minus capacity returned to
//!    this exact lock (change) must not exceed `max_per_tx`. Fees count as
//!    outflow, so they cannot be used to drain the cell.
//! 2. **Rate limit.** If `min_interval > 0`, every input in this group must carry
//!    a relative block-number `since` of at least `min_interval`, so a session
//!    can spend at most once per `min_interval` blocks per cell.
//! 3. **No splitting.** At most one output may go back to this exact lock. A
//!    session spend can merge cells but never multiply them, so the key cannot
//!    split a cell into many and then spend each one in the same interval: the
//!    number of session cells is fixed by the owner.
//! 4. **Recipient.** If a recipient is set, every output must be locked by this
//!    lock (change), the session key lock (its key cell), the owner lock, or the
//!    recipient. Nothing else. Outputs under the session key lock may hold no
//!    more than inputs under it brought in: the key cell can pay the fee but not
//!    grow, or the key could move `max_per_tx` into it each spend and then pay
//!    anyone from there, past the recipient rule.
//! 5. **No type scripts.** This group's inputs and the change must carry no type
//!    script. The limits count capacity only, so a typed session cell (a token)
//!    would let the key move the tokens at zero outflow; and a change cell given a
//!    type the key controls could later refuse every spend, the owner's sweep too,
//!    freezing the whole balance in one transaction.
//!
//! In a token session, rule 5 becomes: a cell may carry no type, or exactly
//! `token_type_hash`. A cell's token amount is the u128 LE in its first 16 data
//! bytes if its type is the token, and 0 otherwise. It is never read from an
//! untyped cell, or the key could make the change "hold" more than came in. Then:
//!
//! 6. **Token outflow.** Tokens in this group's inputs minus tokens in the change
//!    must not exceed `max_per_tx_token`. A token input with under 16 data bytes
//!    is refused; token change must have exactly 16 (no xUDT extension data).
//! 7. **Key cell gets no tokens.** With a recipient set, outputs under the key
//!    lock may hold no more tokens than inputs under it brought in (rule 4 for
//!    tokens), and every other output must be untyped or the token, so the
//!    recipient is paid in the token, not in a cell the key could freeze.
//!
//! The xUDT script still runs and keeps the token's total in check; this lock
//! only bounds how much leaves the session.
//!
//! What it cannot do: enforce an expiry time. A CKB script can prove time has
//! passed (`since` is a lower bound) but never that it has not. Expiry is
//! enforced off-chain; the owner can revoke on-chain at any moment, and the
//! cell's balance caps the total at risk.

#![no_std]
#![no_main]

// No allocator, no atomics: every read below goes into a fixed stack buffer
// through the raw syscalls, so the script needs neither heap nor C support code.
use ckb_std::{
    ckb_constants::{CellField, InputField, Source},
    error::SysError,
    syscalls,
};

ckb_std::entry!(program_entry);

/// ckb-std links `alloc`, so an allocator must exist — but this script never
/// allocates. Any attempt fails, which aborts the script rather than misbehaving.
struct NoAlloc;
unsafe impl core::alloc::GlobalAlloc for NoAlloc {
    unsafe fn alloc(&self, _: core::alloc::Layout) -> *mut u8 {
        core::ptr::null_mut()
    }
    unsafe fn dealloc(&self, _: *mut u8, _: core::alloc::Layout) {}
}
#[global_allocator]
static ALLOCATOR: NoAlloc = NoAlloc;

#[repr(i8)]
enum Error {
    IndexOutOfBound = 1,
    ItemMissing = 2,
    LengthNotEnough = 3,
    Encoding = 4,
    BadArgs = 10,
    NotAuthorized = 11,
    OutflowExceeded = 12,
    RecipientNotAllowed = 13,
    RateLimited = 14,
    CapacityOverflow = 15,
    TooManyChangeCells = 16,
    KeyCellGrew = 17,
    TypedCell = 18,
    TokenData = 19,
    TokenOutflowExceeded = 20,
}

impl From<SysError> for Error {
    fn from(err: SysError) -> Self {
        match err {
            SysError::IndexOutOfBound => Error::IndexOutOfBound,
            SysError::ItemMissing => Error::ItemMissing,
            SysError::LengthNotEnough(_) => Error::LengthNotEnough,
            _ => Error::Encoding,
        }
    }
}

struct Token {
    type_hash: [u8; 32],
    max_per_tx: u128,
}

struct Args {
    owner_lock_hash: [u8; 32],
    session_lock_hash: [u8; 32],
    max_per_tx: u64,
    min_interval: u64,
    token: Option<Token>,
    recipient_lock_hash: Option<[u8; 32]>,
}

fn parse_args(raw: &[u8]) -> Result<Args, Error> {
    let (token, recipient_at) = match raw.len() {
        80 => (false, None),
        112 => (false, Some(80)),
        128 => (true, None),
        160 => (true, Some(128)),
        _ => return Err(Error::BadArgs),
    };
    let hash = |at: usize| -> [u8; 32] { raw[at..at + 32].try_into().unwrap() };
    let u64_at = |at: usize| u64::from_le_bytes(raw[at..at + 8].try_into().unwrap());
    Ok(Args {
        owner_lock_hash: hash(0),
        session_lock_hash: hash(32),
        max_per_tx: u64_at(64),
        min_interval: u64_at(72),
        token: token.then(|| Token {
            type_hash: hash(80),
            max_per_tx: u128::from_le_bytes(raw[112..128].try_into().unwrap()),
        }),
        recipient_lock_hash: recipient_at.map(hash),
    })
}

/// The `args` field of a molecule-encoded Script table:
/// `total_size u32 | 3 field offsets u32 | code_hash | hash_type | args (u32 len + bytes)`.
fn script_args(script: &[u8]) -> Result<&[u8], Error> {
    let u32_at = |at: usize| -> Result<usize, Error> {
        let b = script.get(at..at + 4).ok_or(Error::Encoding)?;
        Ok(u32::from_le_bytes(b.try_into().unwrap()) as usize)
    };
    let total = u32_at(0)?;
    if total != script.len() || u32_at(4)? != 16 {
        return Err(Error::Encoding); // not a 3-field table of the length we read
    }
    let args_at = u32_at(12)?;
    let len = u32_at(args_at)?;
    if args_at + 4 + len != total {
        return Err(Error::Encoding);
    }
    Ok(&script[args_at + 4..total])
}

fn lock_hash(index: usize, source: Source) -> Result<[u8; 32], SysError> {
    let mut buf = [0u8; 32];
    syscalls::load_cell_by_field(&mut buf, 0, index, source, CellField::LockHash)?;
    Ok(buf)
}

fn capacity(index: usize, source: Source) -> Result<u64, SysError> {
    let mut buf = [0u8; 8];
    syscalls::load_cell_by_field(&mut buf, 0, index, source, CellField::Capacity)?;
    Ok(u64::from_le_bytes(buf))
}

fn has_type(index: usize, source: Source) -> Result<bool, SysError> {
    let mut buf = [0u8; 32];
    match syscalls::load_cell_by_field(&mut buf, 0, index, source, CellField::TypeHash) {
        Ok(_) => Ok(true),
        Err(SysError::ItemMissing) => Ok(false),
        Err(e) => Err(e),
    }
}

/// What a cell is to a token session.
enum Held {
    Untyped,
    /// Typed with the session's token: its amount (None if under 16 data bytes) and data length.
    Token { amount: Option<u128>, len: usize },
    /// Any other type script.
    Other,
}

fn held(token: &Token, index: usize, source: Source) -> Result<Held, SysError> {
    let mut hash = [0u8; 32];
    match syscalls::load_cell_by_field(&mut hash, 0, index, source, CellField::TypeHash) {
        Ok(_) => {}
        Err(SysError::ItemMissing) => return Ok(Held::Untyped),
        Err(e) => return Err(e),
    }
    if hash != token.type_hash {
        return Ok(Held::Other);
    }
    let mut data = [0u8; 16];
    let len = match syscalls::load_cell_data(&mut data, 0, index, source) {
        Ok(n) => n,
        Err(SysError::LengthNotEnough(n)) => n,
        Err(e) => return Err(e),
    };
    let amount = (len >= 16).then(|| u128::from_le_bytes(data));
    Ok(Held::Token { amount, len })
}

fn since(index: usize, source: Source) -> Result<u64, SysError> {
    let mut buf = [0u8; 8];
    syscalls::load_input_by_field(&mut buf, 0, index, source, InputField::Since)?;
    Ok(u64::from_le_bytes(buf))
}

/// Calls `f(i, value)` for i = 0, 1, … until the syscall reports the end of the source.
fn each<T>(
    mut load: impl FnMut(usize) -> Result<T, SysError>,
    mut f: impl FnMut(usize, T) -> Result<(), Error>,
) -> Result<(), Error> {
    let mut i = 0;
    loop {
        match load(i) {
            Ok(v) => f(i, v)?,
            Err(SysError::IndexOutOfBound) => return Ok(()),
            Err(e) => return Err(e.into()),
        }
        i += 1;
    }
}

/// `since` flag bits (RFC 0017): bit 63 = relative, bits 61..62 = metric (00 = block number).
const SINCE_FLAGS_MASK: u64 = 0b111 << 61;
const SINCE_RELATIVE_BLOCKS: u64 = 0b100 << 61;
const SINCE_VALUE_MASK: u64 = (1 << 56) - 1;

fn program_entry() -> i8 {
    match run() {
        Ok(()) => 0,
        Err(e) => e as i8,
    }
}

fn run() -> Result<(), Error> {
    // A Script with 160-byte args is 213 bytes; anything that does not fit is not ours.
    let mut script = [0u8; 256];
    let len = match syscalls::load_script(&mut script, 0) {
        Ok(n) => n,
        Err(SysError::LengthNotEnough(_)) => return Err(Error::BadArgs),
        Err(e) => return Err(e.into()),
    };
    let args = parse_args(script_args(&script[..len])?)?;

    let mut owner_present = false;
    let mut session_present = false;
    let mut key_in: u64 = 0;
    each(
        |i| lock_hash(i, Source::Input),
        |i, lock| {
            owner_present |= lock == args.owner_lock_hash;
            if lock == args.session_lock_hash {
                session_present = true;
                if args.recipient_lock_hash.is_some() {
                    key_in = key_in
                        .checked_add(capacity(i, Source::Input)?)
                        .ok_or(Error::CapacityOverflow)?;
                }
            }
            Ok(())
        },
    )?;
    if owner_present {
        return Ok(()); // owner mode: the owner's own lock has authorised everything
    }
    if !session_present {
        return Err(Error::NotAuthorized);
    }

    // Session mode from here on.

    // Tokens entering from this group (rule 6); with no token, rule 5 refuses any type.
    let mut token_in: u128 = 0;
    match &args.token {
        None => each(
            |i| has_type(i, Source::GroupInput),
            |_, typed| if typed { Err(Error::TypedCell) } else { Ok(()) },
        )?,
        Some(token) => each(
            |i| held(token, i, Source::GroupInput),
            |_, cell| match cell {
                Held::Untyped => Ok(()),
                Held::Token { amount: Some(a), .. } => {
                    token_in = token_in.checked_add(a).ok_or(Error::CapacityOverflow)?;
                    Ok(())
                }
                Held::Token { amount: None, .. } => Err(Error::TokenData),
                Held::Other => Err(Error::TypedCell),
            },
        )?,
    }

    if args.min_interval > 0 {
        each(
            |i| since(i, Source::GroupInput),
            |_, since| {
                let relative_blocks = since & SINCE_FLAGS_MASK == SINCE_RELATIVE_BLOCKS;
                if !relative_blocks || since & SINCE_VALUE_MASK < args.min_interval {
                    return Err(Error::RateLimited);
                }
                Ok(())
            },
        )?;
    }

    let mut own_hash = [0u8; 32];
    syscalls::load_script_hash(&mut own_hash, 0)?;

    let mut spent: u64 = 0;
    each(
        |i| capacity(i, Source::GroupInput),
        |_, c| {
            spent = spent.checked_add(c).ok_or(Error::CapacityOverflow)?;
            Ok(())
        },
    )?;
    let mut change: u64 = 0;
    let mut change_cells = 0;
    let mut key_out: u64 = 0;
    let mut token_change: u128 = 0;
    let mut key_token_out: u128 = 0;
    each(
        |i| lock_hash(i, Source::Output),
        |i, lock| {
            if lock == own_hash {
                change_cells += 1;
                if change_cells > 1 {
                    return Err(Error::TooManyChangeCells);
                }
                match &args.token {
                    None if has_type(i, Source::Output)? => return Err(Error::TypedCell),
                    None => {}
                    Some(token) => match held(token, i, Source::Output)? {
                        Held::Untyped => {}
                        // Exactly the amount: no xUDT extension data in the change.
                        Held::Token { amount: Some(a), len: 16 } => token_change = a,
                        Held::Token { .. } => return Err(Error::TokenData),
                        Held::Other => return Err(Error::TypedCell),
                    },
                }
                change = change
                    .checked_add(capacity(i, Source::Output)?)
                    .ok_or(Error::CapacityOverflow)?;
            } else if let Some(recipient) = args.recipient_lock_hash {
                if lock == args.session_lock_hash {
                    key_out = key_out
                        .checked_add(capacity(i, Source::Output)?)
                        .ok_or(Error::CapacityOverflow)?;
                    if let Some(token) = &args.token {
                        match held(token, i, Source::Output)? {
                            Held::Token { amount: Some(a), .. } => {
                                key_token_out = key_token_out.checked_add(a).ok_or(Error::CapacityOverflow)?;
                            }
                            Held::Token { amount: None, .. } => return Err(Error::TokenData),
                            Held::Untyped | Held::Other => {}
                        }
                    }
                } else if lock != recipient && lock != args.owner_lock_hash {
                    return Err(Error::RecipientNotAllowed);
                } else if let Some(token) = &args.token {
                    // Paid in the token, not in a cell typed by a script the key controls.
                    if let Held::Other = held(token, i, Source::Output)? {
                        return Err(Error::TypedCell);
                    }
                }
            }
            Ok(())
        },
    )?;
    if key_out > key_in {
        return Err(Error::KeyCellGrew);
    }
    // Topping the cell up (change > spent) is an outflow of zero.
    if spent.saturating_sub(change) > args.max_per_tx {
        return Err(Error::OutflowExceeded);
    }

    if let Some(token) = &args.token {
        if args.recipient_lock_hash.is_some() {
            // Tokens the key's own cells brought in, read only now, in session mode.
            // A malformed key-locked input counts as 0, which can only make this stricter.
            let mut key_token_in: u128 = 0;
            each(
                |i| lock_hash(i, Source::Input),
                |i, lock| {
                    if lock == args.session_lock_hash {
                        if let Held::Token { amount: Some(a), .. } = held(token, i, Source::Input)? {
                            key_token_in = key_token_in.checked_add(a).ok_or(Error::CapacityOverflow)?;
                        }
                    }
                    Ok(())
                },
            )?;
            if key_token_out > key_token_in {
                return Err(Error::KeyCellGrew);
            }
        }
        // As with capacity, a top-up (change > in) is an outflow of zero.
        if token_in.saturating_sub(token_change) > token.max_per_tx {
            return Err(Error::TokenOutflowExceeded);
        }
    }
    Ok(())
}
