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
//! Args (80 or 112 bytes):
//!
//! | bytes  | field               | meaning                                          |
//! |--------|---------------------|--------------------------------------------------|
//! | 0..32  | owner_lock_hash     | lock hash whose presence grants owner mode       |
//! | 32..64 | session_lock_hash   | lock hash whose presence grants session mode     |
//! | 64..72 | max_per_tx (u64 LE) | most shannons one session spend may move out     |
//! | 72..80 | min_interval (u64)  | blocks each session-locked input must have aged  |
//! | 80..112| recipient_lock_hash | optional: the only lock session spends may pay   |
//!
//! Session-mode rules:
//!
//! 1. **Outflow.** Capacity of this group's inputs minus capacity returned to
//!    this exact lock (change) must not exceed `max_per_tx`. Fees count as
//!    outflow, so they cannot be used to drain the cell.
//! 2. **Rate limit.** If `min_interval > 0`, every input in this group must carry
//!    a relative block-number `since` of at least `min_interval`, so a session
//!    can spend at most once per `min_interval` blocks per cell.
//! 3. **Recipient.** If a recipient is set, every output must be locked by this
//!    lock (change), the session key lock (its key cell), the owner lock, or the
//!    recipient. Nothing else.
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

struct Args {
    owner_lock_hash: [u8; 32],
    session_lock_hash: [u8; 32],
    max_per_tx: u64,
    min_interval: u64,
    recipient_lock_hash: Option<[u8; 32]>,
}

fn parse_args(raw: &[u8]) -> Result<Args, Error> {
    if raw.len() != 80 && raw.len() != 112 {
        return Err(Error::BadArgs);
    }
    let hash = |at: usize| -> [u8; 32] { raw[at..at + 32].try_into().unwrap() };
    let u64_at = |at: usize| u64::from_le_bytes(raw[at..at + 8].try_into().unwrap());
    Ok(Args {
        owner_lock_hash: hash(0),
        session_lock_hash: hash(32),
        max_per_tx: u64_at(64),
        min_interval: u64_at(72),
        recipient_lock_hash: (raw.len() == 112).then(|| hash(80)),
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
    // A Script with 112-byte args is 185 bytes; anything that does not fit is not ours.
    let mut script = [0u8; 256];
    let len = match syscalls::load_script(&mut script, 0) {
        Ok(n) => n,
        Err(SysError::LengthNotEnough(_)) => return Err(Error::BadArgs),
        Err(e) => return Err(e.into()),
    };
    let args = parse_args(script_args(&script[..len])?)?;

    let mut owner_present = false;
    let mut session_present = false;
    each(
        |i| lock_hash(i, Source::Input),
        |_, lock| {
            owner_present |= lock == args.owner_lock_hash;
            session_present |= lock == args.session_lock_hash;
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
    each(
        |i| lock_hash(i, Source::Output),
        |i, lock| {
            if lock == own_hash {
                change = change
                    .checked_add(capacity(i, Source::Output)?)
                    .ok_or(Error::CapacityOverflow)?;
            } else if let Some(recipient) = args.recipient_lock_hash {
                let allowed =
                    lock == recipient || lock == args.session_lock_hash || lock == args.owner_lock_hash;
                if !allowed {
                    return Err(Error::RecipientNotAllowed);
                }
            }
            Ok(())
        },
    )?;
    // Topping the cell up (change > spent) is an outflow of zero.
    if spent.saturating_sub(change) > args.max_per_tx {
        return Err(Error::OutflowExceeded);
    }
    Ok(())
}
