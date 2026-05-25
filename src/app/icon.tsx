import { ImageResponse } from "next/og";

// Next.js file convention: auto-served at /icon and referenced from
// the document <head> as a <link rel="icon"> with the matching size.
// Used by the PWA manifest as the 192px web-app icon and as the
// browser tab favicon at retina sizes.
//
// Rendered programmatically via next/og rather than checked-in PNGs:
// the design is a flat type lockup that scales cleanly, and keeping
// the source as JSX means future theme tweaks (gold hue, bg color)
// flow through automatically.

export const size = { width: 192, height: 192 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0a0a0a",
          color: "#e9b13c",
          fontSize: 92,
          fontWeight: 900,
          letterSpacing: "-0.04em",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        PFA
      </div>
    ),
    { ...size },
  );
}
