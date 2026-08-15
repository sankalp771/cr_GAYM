import Link from "next/link";
import { DemoBoard } from "@/components/home/demo-board";
import styles from "./home.module.css";

/**
 * The landing page.
 *
 * Its one job is to make someone understand the game and press Play. The board
 * in the hero is not a picture of the game — it is the game, playing itself
 * through the real engine, because a chain reaction is the thing being sold and
 * a still frame of one sells nothing.
 */

const STEPS = [
  {
    title: "Claim a cell",
    body: "Tap any empty cell, or one you already own. You can never play on someone else's."
  },
  {
    title: "Overload it",
    body: "A cell bursts once it holds as many orbs as it has neighbours — two in a corner, three on an edge, four in the middle."
  },
  {
    title: "Take the board",
    body: "The blast pushes one orb into each neighbour and flips them to your colour. They can burst in turn. Chains can end a match in a single move."
  }
];

export default function HomePage() {
  return (
    <main className={styles.shell}>
      <div className={`${styles.ambient} ${styles.ambientA}`} aria-hidden="true" />
      <div className={`${styles.ambient} ${styles.ambientB}`} aria-hidden="true" />
      <div className={styles.grid} aria-hidden="true" />

      <section className={`${styles.card} ${styles.hero}`}>
        <div>
          <p className={styles.eyebrow}>Chain Reaction Global</p>

          <h1 className={styles.title}>
            Place one orb.
            <br />
            Take the <em>whole board.</em>
          </h1>

          <p className={styles.lede}>
            Fill a cell past the number of neighbours it has and it detonates into all of them, flipping their colour
            on the way. Those cells can detonate too. The right placement collapses an entire board at once.
          </p>

          <div className={styles.actions}>
            <Link className="primary-link" href="/local">
              Play Local
            </Link>
            <Link className="ghost-link" href="/multiplayer">
              Play Online
            </Link>
          </div>

          <p className={styles.status}>Online rooms are live</p>

          <ul className={styles.specs}>
            <li>2–8 players</li>
            <li>4 bot levels</li>
            <li>No signup</li>
          </ul>
        </div>

        <div className={styles.demo}>
          <DemoBoard />
          <p className={styles.demoCaption}>
            <span>Live demo</span>
            <span>Three bots, playing now</span>
          </p>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="how-it-works">
        <div className={styles.sectionHead}>
          <h2 id="how-it-works" className={styles.sectionLabel}>
            How it works
          </h2>
          <p className={styles.sectionNote}>Three rules. That is the entire game.</p>
        </div>

        <div className={styles.steps}>
          {STEPS.map((step) => (
            <article key={step.title} className={styles.step}>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.section} aria-labelledby="ways-to-play">
        <div className={styles.sectionHead}>
          <h2 id="ways-to-play" className={styles.sectionLabel}>
            Ways to play
          </h2>
        </div>

        <div className={styles.modes}>
          <article className={styles.mode}>
            <h3 className={styles.modeTitle}>
              On this device
              <span className={styles.modeTag}>Local</span>
            </h3>
            <p>Pass the phone around, or fill the empty seats with computer opponents.</p>
            <ul className={styles.modeList}>
              <li>Two to eight seats, each set to a human or a bot</li>
              <li>Four difficulties, from careless to a real depth search</li>
              <li>Board presets from compact to XXL, and a turn timer</li>
            </ul>
            <div className={styles.modeAction}>
              <Link className="primary-link" href="/local">
                Start a local match
              </Link>
            </div>
          </article>

          <article className={styles.mode}>
            <h3 className={styles.modeTitle}>
              With friends
              <span className={styles.modeTag}>Online</span>
            </h3>
            <p>Create a room, send the link, and play from anywhere. Nothing to install.</p>
            <ul className={styles.modeList}>
              <li>The server holds the rules, so nobody can disagree about a move</li>
              <li>Refresh or lose signal and you come back to the same seat</li>
              <li>A turn timer plays for anyone who drops, so a match never stalls</li>
            </ul>
            <div className={styles.modeAction}>
              <Link className="ghost-link" href="/multiplayer">
                Create or join a room
              </Link>
            </div>
          </article>
        </div>
      </section>

      <footer className={styles.footer}>Chain Reaction Global — built for phones first</footer>
    </main>
  );
}
