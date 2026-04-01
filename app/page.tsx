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

      <section className="hero-card">
        <div className="eyebrow">Chain Reaction Global</div>
        <h1>Choose Your Mode</h1>
        <p className="hero-copy">
          Local play and web multiplayer now live on separate paths so one mode never breaks the other again.
        </p>

        <div className="mode-grid">
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
        </div>
      </section>
    </main>
  );
}
