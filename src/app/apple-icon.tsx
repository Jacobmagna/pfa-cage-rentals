import { ImageResponse } from "next/og";

// iOS "Add to Home Screen" icon. 180×180 is the modern iOS size.
// iOS applies its own rounded-rect mask, so we leave the outer box
// square — the rotated yellow diamond inside stays inset enough that
// iOS's mask doesn't clip it. Matches the brand mark used in icon.tsx
// and in the inline <DiamondMark> SVG component.

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
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
            width: "100px",
            height: "100px",
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
