import { ImageResponse } from "next/og";

// Next.js file convention: auto-served at /icon and referenced from
// the document <head> as a <link rel="icon"> with the matching size.
// Used by the PWA manifest as the 192px web-app icon and as the
// browser tab favicon at retina sizes.
//
// Brand mark: a filled yellow diamond on a near-black square. Same
// shape as the inline <DiamondMark> SVG used in the nav and landing
// page — see src/app/_components/diamond-mark.tsx. At 16px tab size
// a stroked outline disappears, so we render filled here. The mark
// reads as a baseball diamond at a glance without being a literal
// home-plate icon.
//
// Drawn as a 45°-rotated <div> rather than inline <svg> because
// next/og's HTML+CSS subset handles rotated boxes more reliably
// than arbitrary SVG.

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
        }}
      >
        <div
          style={{
            width: "108px",
            height: "108px",
            background: "#FFC400",
            transform: "rotate(45deg)",
            borderRadius: "10px",
          }}
        />
      </div>
    ),
    { ...size },
  );
}
