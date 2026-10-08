import { readFile } from "node:fs/promises";
import { ImageResponse } from "next/og";

// The home-screen icon is the favicon (icon.svg) rendered at 180×180 as a PNG.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default async function AppleIcon() {
  const svg = await readFile(new URL("./icon.svg", import.meta.url), "utf8");
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  return new ImageResponse(
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} width={180} height={180} alt="" />,
    size,
  );
}
