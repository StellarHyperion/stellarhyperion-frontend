import styles from "./AmbientRoutes.module.css";

/** Decorative orbital paths. They never represent transactions or route availability. */
export function AmbientRoutes() {
  return (
    <div className={styles.backdrop} aria-hidden="true">
      <div className={styles.glow} />
      <svg className={styles.orbits} viewBox="0 0 1440 1000" fill="none">
        <defs>
          <linearGradient
            id="ambient-route"
            x1="100"
            y1="200"
            x2="1300"
            y2="850"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="var(--leg-origin)" />
            <stop offset="0.5" stopColor="var(--graphic-muted)" />
            <stop offset="1" stopColor="var(--leg-destination)" />
          </linearGradient>
        </defs>
        <g className={styles.network} stroke="url(#ambient-route)">
          <ellipse cx="720" cy="520" rx="670" ry="180" transform="rotate(-24 720 520)" />
          <ellipse cx="720" cy="520" rx="710" ry="280" transform="rotate(26 720 520)" />
          <ellipse cx="720" cy="520" rx="510" ry="430" transform="rotate(-12 720 520)" />
        </g>
        <g className={styles.signals} stroke="url(#ambient-route)">
          <ellipse
            cx="720"
            cy="520"
            rx="670"
            ry="180"
            transform="rotate(-24 720 520)"
            pathLength="100"
          />
          <ellipse
            cx="720"
            cy="520"
            rx="710"
            ry="280"
            transform="rotate(26 720 520)"
            pathLength="100"
          />
          <ellipse
            cx="720"
            cy="520"
            rx="510"
            ry="430"
            transform="rotate(-12 720 520)"
            pathLength="100"
          />
        </g>
        <g className={styles.nodes} fill="var(--leg-origin)">
          <circle cx="193" cy="758" r="3" />
          <circle cx="1226" cy="294" r="3" />
          <circle cx="1114" cy="785" r="2" />
          <circle cx="295" cy="239" r="2" />
        </g>
      </svg>
    </div>
  );
}
