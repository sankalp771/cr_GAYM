import { MultiplayerRoom } from "@/components/multiplayer/multiplayer-room";

export const metadata = {
  title: "Play Online — Chain Reaction Global",
  description: "Create or join a room and play Chain Reaction across devices."
};

export default function MultiplayerPage() {
  return <MultiplayerRoom />;
}
