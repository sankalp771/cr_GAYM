import Link from "next/link";

const modes = [
  {
    href: "/local",
    badge: "Playable Now",
    title: "Local Game",
    description:
      "Single-device Chain Reaction with glow effects, board presets, turn timer, and auto-play on timeout.",
    cta: "Play Local"
  },
  {
    href: "/multiplayer",
    badge: "Phase 3",
    title: "Web Multiplayer",
    description:
      "Separated room flow for cross-device play. We’ll fix the socket runtime here next without touching local mode.",
    cta: "Open Multiplayer"
  }
];

export default function HomePage() {
  return (
    <main className="home-shell">
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />
      <div className="background-grid" />

      <section className="hero-card landing-hero">
        <div className="landing-copy">
          <div className="eyebrow">Chain Reaction Global</div>
          <h1>Neon Battles. Chain Reactions. Global Ambition.</h1>
          <p className="hero-copy">
            A premium competitive take on Chain Reaction with a glowing arena, dramatic turn pressure, and a clean split
            between stable local play and future cross-device multiplayer.
          </p>

          <div className="landing-actions">
            <Link className="primary-link" href="/local">
              Launch Local Battle
            </Link>
            <Link className="ghost-link" href="/multiplayer">
              Open Multiplayer Lab
            </Link>
          </div>
        </div>

        <div className="landing-preview">
          <div className="preview-hud">
            <div className="preview-player preview-red">
              <span>Player 1</span>
              <strong>Charged</strong>
            </div>
            <div className="preview-timer">12</div>
            <div className="preview-player preview-blue">
              <span>Player 2</span>
              <strong>Responding</strong>
            </div>
          </div>

          <div className="preview-board-frame">
            <div className="preview-board">
              {Array.from({ length: 36 }, (_, index) => {
                const hot = [7, 8, 13, 14, 15, 20, 21, 28].includes(index);
                const blue = [11, 17, 23, 29].includes(index);
                const green = [9, 10, 16, 27].includes(index);

                let orbClass = "";
                if (hot) orbClass = "red";
                if (blue) orbClass = "blue";
                if (green) orbClass = "green";

                return (
                  <div key={`preview-${index}`} className={`preview-cell ${hot ? "burst" : ""}`}>
                    {orbClass ? <span className={`preview-orb ${orbClass}`} /> : null}
                  </div>
                );
              })}
            </div>
            <div className="preview-reaction-bar">
              <span>Control the board.</span>
              <span>Trigger the chain.</span>
              <span>Own the finish.</span>
            </div>
          </div>
        </div>
      </section>

      <section className="mode-grid landing-mode-grid">
        {modes.map((mode) => (
          <article key={mode.href} className="mode-card">
            <span className="mode-badge">{mode.badge}</span>
            <h2>{mode.title}</h2>
            <p>{mode.description}</p>
            <Link className="primary-link" href={mode.href}>
              {mode.cta}
            </Link>
          </article>
        ))}
      </section>
    </main>
  );
}
