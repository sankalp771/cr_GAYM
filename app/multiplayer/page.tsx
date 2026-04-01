import Link from "next/link";

export default function MultiplayerPage() {
  return (
    <main className="mode-shell">
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />
      <div className="background-grid" />

      <section className="mode-header-card">
        <div>
          <div className="eyebrow">Phase 3 Workspace</div>
          <h1>Web Multiplayer</h1>
          <p className="hero-copy">
            This mode is now isolated from local play. Room sockets, ready flow, and cross-device sync will be fixed
            here next.
          </p>
        </div>

        <div className="header-actions">
          <Link href="/" className="ghost-link">
            Back Home
          </Link>
          <Link href="/local" className="primary-link">
            Open Local Mode
          </Link>
        </div>
      </section>

      <section className="mode-grid multiplayer-grid">
        <article className="info-card">
          <div className="card-title-row">
            <h2>What Happens Here Next</h2>
            <span className="mode-badge">Queued</span>
          </div>
          <ul className="info-list">
            <li>Create room and join room flow</li>
            <li>Room code and shareable link</li>
            <li>Host start and player ready states</li>
            <li>Authoritative WebSocket turns</li>
            <li>Reconnect and spectator continuation</li>
          </ul>
        </article>

        <article className="info-card">
          <div className="card-title-row">
            <h2>Why It&apos;s Separated</h2>
          </div>
          <p className="info-copy">
            The previous mixed screen let unfinished socket work interfere with the local game. This page keeps
            multiplayer isolated so local remains stable while we finish Phase 3 properly.
          </p>
        </article>
      </section>
    </main>
  );
}
