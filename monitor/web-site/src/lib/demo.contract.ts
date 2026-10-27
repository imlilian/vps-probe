import type { Node } from "@/lib/api"
import { nodeList } from "../../dev/demoData.ts"

/**
 * `dev/demoData.ts` builds the sample fleet without naming a type: the node
 * project compiles that file too, and it has no `@/` alias. This is where the
 * compiler compares the two, so a field the page gains and the sample data does
 * not is a build error rather than a blank cell in the demo.
 *
 * Nothing imports this file, so it is in neither bundle; it is a type check with
 * a filename.
 */
export const fits: (sample: ReturnType<typeof nodeList>) => Node[] = (sample) => sample
