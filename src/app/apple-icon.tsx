import { ImageResponse } from "next/og";

// iOS "Add to Home Screen" icon. 180×180 is the modern iOS size
// (down from 192 used historically; newer iOS upsamples cleanly).
// iOS applies its own rounded-rect mask, so we leave corners square.

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
          color: "#e9b13c",
          fontSize: 88,
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
