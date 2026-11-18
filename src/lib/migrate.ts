// Older saved worlds lack newer fields. Fill them in when a world is loaded.
import type { World } from "./types";

export function migrate(w: World): World {
  w.board ??= [];
  w.boardSeq ??= 0;
  for (const c of Object.values(w.creatures)) c.goal ??= "";
  return w;
}
