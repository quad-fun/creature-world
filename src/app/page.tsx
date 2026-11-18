import { after } from "next/server";
import { advanceWorld, loadWorld } from "@/lib/engine";
import { publicView } from "@/lib/view";
import { Town } from "./town";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function Home() {
  const { world, storage } = await loadWorld();
  after(async () => {
    try {
      await advanceWorld();
    } catch (e) {
      console.error("tick failed", e);
    }
  });
  return <Town initial={publicView(world, storage)} />;
}
