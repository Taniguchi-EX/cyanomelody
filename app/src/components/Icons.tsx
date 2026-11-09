// 文字の記号では見分けにくいアイコン（自作の SVG）。色は文字の色（currentColor）に合わせる

/** 設定の歯車 */
export function GearIcon() {
  const teeth = Array.from({ length: 8 }, (_, i) => (i * Math.PI) / 4);
  return (
    <svg className="svg-icon" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" data-icon="gear">
      <g stroke="currentColor" fill="none">
        {teeth.map((a) => (
          <line
            key={a}
            x1={12 + 6 * Math.cos(a)}
            y1={12 + 6 * Math.sin(a)}
            x2={12 + 10.2 * Math.cos(a)}
            y2={12 + 10.2 * Math.sin(a)}
            strokeWidth="3.6"
          />
        ))}
        <circle cx="12" cy="12" r="5.8" strokeWidth="3.4" />
      </g>
    </svg>
  );
}

/** 音量のスピーカー。0 なら「×」、小さければ波1つ、大きければ波2つ */
export function SpeakerIcon({ volume }: { volume: number }) {
  return (
    <svg
      className="svg-icon"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      aria-hidden="true"
      data-icon={volume === 0 ? "speaker-muted" : "speaker"}
    >
      <path d="M3 9h4l5-4v14l-5-4H3z" fill="currentColor" />
      <g stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none">
        {volume === 0 ? (
          <path d="M16 9l6 6M22 9l-6 6" />
        ) : (
          <>
            <path d="M15.5 9a4 4 0 0 1 0 6" />
            {volume >= 0.5 && <path d="M18.5 6a8.5 8.5 0 0 1 0 12" />}
          </>
        )}
      </g>
    </svg>
  );
}
