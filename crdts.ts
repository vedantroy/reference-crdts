import assert from 'assert'
import consoleLib from 'console'
import chalk from 'chalk'

globalThis.console = new consoleLib.Console({
  stdout: process.stdout, stderr: process.stderr,
  inspectOptions: {depth: null}
})

// atEnd flag for sync9.
export type Id = [agent: string, seq: number]
export type Version = Record<string, number> // Last seen seq for each agent.

export type Algorithm = {
  localInsert: <T>(this: Algorithm, doc: Doc<T>, agent: string, pos: number, content: T) => void
  integrate: <T>(doc: Doc<T>, newItem: Item<T>, idx_hint?: number) => void
  printDoc: <T>(doc: Doc<T>) => void
  ignoreTests?: string[]
}

// These aren't used, but they should be. They show how the items actually work for each algorithm.
type YjsItem<T> = {
  content: T,
  id: Id,

  // Left and right implicit in document list.
  // null represents document's root / end.
  originLeft: Id | null,
  originRight: Id | null,

  isDeleted: boolean,
}

type AMItem<T> = {
  content: T,
  id: Id,

  originLeft: Id | null,
  seq: number, // Must be larger than all prev sequence numbers on the peer that created this.

  isDeleted: boolean,
}

type Sync9Item<T> = {
  // Sync9 items are splittable spans - which is weird in this
  // library because items only contain 1 entry. So the entry is
  // nullable, thus having length 0 or 1.
  content: T | null,

  id: Id,

  originLeft: Id | null,
  insertAfter: boolean, // identifies whether we insert at the start / end of originLeft.

  isDeleted: boolean,
}

export type Item<T> = {
  // Sync9 items must be splittable spans - which is weird in this
  // library because items only contain 1 entry. So the entry is
  // nullable, thus having length 0 or 1.
  content: T | null,

  // For sync9 the seq must advance by 2 each time, so we have insert positions both before and after this item.
  id: Id,

  originLeft: Id | null,
  originRight: Id | null,
  seq: number,
  insertAfter: boolean, // Only for sync9.

  isDeleted: boolean,
}



export interface Doc<T = string> {
  content: Item<T>[] // Could take Item as a type parameter, but eh. This is better for demos.

  version: Version // agent => last seen seq.
  length: number // Number of items not deleted

  maxSeq: number // Only for AM.
}

export const newDoc = <T>(): Doc<T> => ({
  content: [],
  version: {},
  length: 0,
  maxSeq: 0,
})

// **** Common code and helpers

// We never actually compare the third argument in sync9.
const idEq2 = (a: Id | null, agent: string, seq: number): boolean => (
  a != null && (a[0] === agent && a[1] === seq)
)
const idEq = (a: Id | null, b: Id | null): boolean => (
  a == b || (a != null && b != null && a[0] === b[0] && a[1] === b[1])
)

let hits = 0
let misses = 0

// idx_hint is a small optimization so when we know the general area of
// an item, we search nearby instead of just scanning the whole document.
const findItem2 = <T>(doc: Doc<T>, needle: Id | null, atEnd: boolean = false, idx_hint: number = -1): number => {
  if (needle == null) return -1
  else {
    const [agent, seq] = needle
    // This little optimization *halves* the time to run the editing trace benchmarks.
    if (idx_hint >= 0 && idx_hint < doc.content.length) {
      const hint_item = doc.content[idx_hint]
      if ((!atEnd && idEq2(hint_item.id, agent, seq))
          || (hint_item.content != null && atEnd && idEq2(hint_item.id, agent, seq))) {
        hits++
        return idx_hint
      }
      // Try nearby.
      // const RANGE = 10
      // for (let i = idx_hint < RANGE ? 0 : idx_hint - RANGE; i < doc.content.length && i < idx_hint + RANGE; i++) {
      //   const item = doc.content[i]
      //   if ((!atEnd && idEq2(item.id, agent, seq))
      //       || (item.content != null && atEnd && idEq2(item.id, agent, seq))) {
      //     hits++
      //     return i
      //   }
      // }
    }

    misses++
    const idx = doc.content.findIndex(({content, id}) => (
      (!atEnd && idEq2(id, agent, seq)) || (content != null && atEnd && idEq2(id, agent, seq)))
    )
      // : doc.content.findIndex(({id}) => idEq(id, needle))
    if (idx < 0) throw Error('Could not find item') // Could use a ternary if not for this!
    return idx
  }
}

const findItem = <T>(doc: Doc<T>, needle: Id | null, idx_hint: number = -1): number => (
  findItem2(doc, needle, false, idx_hint)
)

// const getNextSeq = <T>(doc: Doc<T>, agent: string): number => {
//   const last = doc.version[agent]
//   return last == null ? 0 : last + 1
// }

const findItemAtPos = <T>(doc: Doc<T>, pos: number, stick_end: boolean = false): number => {
  let i = 0
  // console.log('pos', pos, doc.length, doc.content.length)
  for (; i < doc.content.length; i++) {
    const item = doc.content[i]
    if (stick_end && pos === 0) return i
    else if (item.isDeleted || item.content == null) continue
    else if (pos === 0) return i

    pos--
  }

  if (pos === 0) return i
  else throw Error('past end of the document')
}

// const nextSeq = (agent: string): number =>

function localInsert<T>(this: Algorithm, doc: Doc<T>, agent: string, pos: number, content: T) {
  let i = findItemAtPos(doc, pos)
  this.integrate(doc, {
    content,
    id: [agent, (doc.version[agent] ?? -1) + 1],
    isDeleted: false,
    originLeft: doc.content[i - 1]?.id ?? null,
    originRight: doc.content[i]?.id ?? null, // Only for yjs
    insertAfter: true, // Unused by yjs and AM.
    seq: doc.maxSeq + 1, // Only for AM.
  }, i)
}

function localInsertSync9<T>(this: Algorithm, doc: Doc<T>, agent: string, pos: number, content: T) {
  let i = findItemAtPos(doc, pos, true)
  // For sync9 our insertion point is different based on whether or not our parent has children.
  let parentIdBase = doc.content[i - 1]?.id ?? null
  let originLeft: Id | null = parentIdBase == null ? null : [parentIdBase[0], parentIdBase[1]]
  let insertAfter = true

  for (;; i++) {
    // Scan until we find something with no children to insert after.
    let nextItem = doc.content[i]
    if (nextItem == null || !idEq(nextItem.originLeft, parentIdBase)) break

    parentIdBase = nextItem.id
    originLeft = [nextItem.id[0], nextItem.id[1]]
    insertAfter = false
    // If the current item has content, we need to slice it and insert before its content.
    if (nextItem.content != null) break
  }

  // console.log('parentId', parentId)

  this.integrate(doc, {
    content,
    id: [agent, (doc.version[agent] ?? -1) + 1],
    isDeleted: false,
    originLeft,
    insertAfter,

    originRight: null, // Only for yjs
    seq: 0, // Only for AM.
  }, i)
}

export const localDelete = <T>(doc: Doc<T>, agent: string, pos: number): void => {
  // This is very incomplete.
  const item = doc.content[findItemAtPos(doc, pos)]
  if (!item.isDeleted) {
    item.isDeleted = true
    doc.length -= 1
  }
}

export const getArray = <T>(doc: Doc<T>): T[] => (
  doc.content.filter(i => !i.isDeleted && i.content != null).map(i => i.content!)
)

const printdoc = <T>(doc: Doc<T>, showSeq: boolean, showOR: boolean, showIsAfter: boolean) => {
  const depth: Record<string, number> = {}
  // const kForId = (id: Id, c: T | null) => `${id[0]} ${id[1]} ${id[2] ?? c != null}`
  const kForItem = (id: Id, isAfter: boolean) => `${id[0]} ${id[1]} ${isAfter}`
  for (const i of doc.content) {
    const d = i.originLeft == null ? 0 : depth[kForItem(i.originLeft, i.insertAfter)] + 1
    depth[kForItem(i.id, i.content != null)] = d

    let content = `${i.content == null
      ? '.'
      : i.isDeleted ? chalk.strikethrough(i.content) : chalk.yellow(i.content)
    } at [${i.id}] (parent [${i.originLeft}])`
    if (showSeq) content += ` seq ${i.seq}`
    if (showOR) content += ` originRight [${i.originRight}]`
    if (showIsAfter) content += ` ${i.insertAfter ? 'after' : chalk.blue('before')}`
    // console.log(`${'| '.repeat(d)}${i.content == null ? chalk.strikethrough(content) : content}`)
    console.log(`${'| '.repeat(d)}${i.content == null ? chalk.grey(content) : content}`)
  }
}

export const isInVersion = (id: Id | null, version: Version) => {
  if (id == null) return true
  const seq = version[id[0]]
  return seq != null && seq >= id[1]
}

export const canInsertNow = <T>(op: Item<T>, doc: Doc<T>): boolean => (
  // We need op.id to not be in doc.versions, but originLeft and originRight to be in.
  // We're also inserting each item from each agent in sequence.
  !isInVersion(op.id, doc.version)
    && (op.id[1] === 0 || isInVersion([op.id[0], op.id[1] - 1], doc.version))
    && isInVersion(op.originLeft, doc.version)
    && isInVersion(op.originRight, doc.version)
)

// Merge all missing items from src into dest.
// NOTE: This currently does not support moving deletes!
export const mergeInto = <T>(algorithm: Algorithm, dest: Doc<T>, src: Doc<T>) => {
  // The list of operations we need to integrate
  const missing: (Item<T> | null)[] = src.content.filter(op => op.content != null && !isInVersion(op.id, dest.version))
  let remaining = missing.length

  while (remaining > 0) {
    // Find the next item in remaining and insert it.
    let mergedOnThisPass = 0

    for (let i = 0; i < missing.length; i++) {
      const op = missing[i]
      if (op == null || !canInsertNow(op, dest)) continue
      algorithm.integrate(dest, op)
      missing[i] = null
      remaining--
      mergedOnThisPass++
    }

    assert(mergedOnThisPass)
  }
}


// *** Per algorithm integration functions. Note each CRDT will only use
// one of these integration methods depending on the desired semantics.

// This is a slight modification of yjs with a few tweaks to make some
// of the CRDT puzzles resolve better.
const integrateYjsMod = <T>(doc: Doc<T>, newItem: Item<T>, idx_hint: number = -1) => {
  // Ved: In this algo, each "item" has a pred & a succ elemId
  // These notes are in the context of having these ops applied in sequence
  // to a document:
  //  ```
  //  makeItem('a', ['A', 0], null, null, 0),
  //  makeItem('a', ['A', 1], ['A', 0], null, 1),
  //  makeItem('a', ['A', 2], ['A', 1], null, 2),

  //  makeItem('b', ['B', 0], null, null, 0),
  //  makeItem('b', ['B', 1], ['B', 0], null, 1),
  //  makeItem('b', ['B', 2], ['B', 1], null, 2),
  //  ```

  // Ved: `id[0]` is the agent name
  // `id[1]` is the `seq`. (*Different* from Automerge's "seq")
  // Assert that the seq increments by 1 each time (logical meaning:
  // we are receiving ops from the agent in order)
  const lastSeen = doc.version[newItem.id[0]] ?? -1
  if (newItem.id[1] !== lastSeen + 1) throw Error('Operations out of order')
  doc.version[newItem.id[0]] = newItem.id[1]

  // Ved: This is the numerical index of the item we want to insert after
  // (`originLeft` is the elemId, which is resilient in the face of
  // concurrency. But we need a list index to well... update/read from the list)
  // We are essentially translating `originLeft` to a list index
  // In the first pass:
  // `originLeft` == null, `left` == -1, `destIdx == 0`
  let left = findItem(doc, newItem.originLeft, idx_hint - 1)
  let destIdx = left + 1
  // Ved: Same thing here, but with `originRight`
  // When inserting "a"s, `right` = 0,1,2
  // When inserting "b"s, `right` = 3,4,5
  // b/c `newItem.originRight` is always null
  let right = newItem.originRight == null ? doc.content.length : findItem(doc, newItem.originRight, idx_hint)
  let scanning = false

  for (let i = destIdx; ; i++) {
    // Ved: If scanning is false then `destIdx == i`
    // otherwise (`scanning == true`), `i` increments but `destIdx` remains the same
    // Why? In between `left` & `right` there might be one or more chunks/spans that were
    // inserted concurrently. To prevent interleaving we need to insert before/after
    // one of these chunks, but when we first start scanning a chunk we don't know whether
    // to insert before or after (that depends on user agent comparisons??)
    // Example: If one user types "aaa" and the other "bbb": aaabbb & bbbaaa are fine,
    // but we don't want to insert in-between a chunk/span, e.g, ababab
    if (!scanning) destIdx = i
    // Ved: We've reached the end of the document without hitting the rightmost elemId
    // insert at the end of the document
    // In `interleavingForward` in the scenario where
    // - First: do 3 insert "a" ops from the same agent
    // - Second: do 3 insert "b" ops from a different agent
    // In the first phase, we'll always hit the break on this if statement
    // on the 1st iteration of this loop b/c
    // item #, left, destIdx, doc.content.length
    //  0       -1     0      0 (no inserts yet)
    //  1        0     1      1
    //  2        1     2      2
    // we've finished inserting 3 "a"s... now, for the "b"s this is different...
    // for the 2nd & 3rd "b"s `left` will be the index of the last item in
    // the doc, so we hit this cond on the 1st iter & break
    if (i === doc.content.length) break
    if (i === right) break // No ambiguity / concurrency. Insert here.

    // VED: We only reach this case when inserting "b"s... 
    let other = doc.content[i]

    // VED: `oleft` = pred of other, `oright` = succ of other
    // Values table:
    // Inserting 1st "b" (0,0..=2) for ("b" item #, loop iter #)
    //  iter #, oleft, oright
    //   0        -1   3
    //   0         0   3
    //   0         1   3
    //  left = -1; right = 3
    let oleft = findItem(doc, other.originLeft, idx_hint - 1)
    let oright = other.originRight == null ? doc.content.length : findItem(doc, other.originRight, idx_hint)

    // The logic below summarizes to:
    // if (oleft < left || (oleft === left && oright === right && newItem.id[0] < o.id[0])) break
    // if (oleft === left) scanning = oright < right

    if (oleft < left) {
      break
    } else if (oleft === left) {
      if (oright < right) {
        // This is tricky. We're looking at an item we *might* insert after - but we can't tell yet!
        scanning = true
        continue
      } else if (oright === right) {
        // VED: We enter this case on (0,0)
        // Raw conflict. Order based on user agents.
        if (newItem.id[0] < other.id[0]) break
        else {
          // VED: We lose the user agent tie breaker ("B" > "A"),
          // so we will be inserted after the current span of inserts
          scanning = false
          continue
        }
      } else { // oright > right
        scanning = false
        continue
      }
    } else { // oleft > left
      // VED: We are inside an chunk/span of inserts by another user
      // we will keep on going forward until we reach the end of this span
      // b/c a span of inserts (left to right) has the property that
      // `oleft` will increment by 1 each time so the condition `oleft > left`
      // will be true until that span finishes
      // We enter this case on (0, 1 | 2) b/c the 1st "b" will have `left  -1"
      // (since it's pred is the start of the doc while the "a"s will have preds
      // that keep on increasing)
      continue
    }
  }

  // We've found the position. Insert here.
  doc.content.splice(destIdx, 0, newItem)
  if (!newItem.isDeleted) doc.length += 1
}

// VED: This is not used. This is a commented version of `integrateYjsMod`
// for the case where we insert "bbb" then "aaa".
const integrateYjsMod2 = <T>(doc: Doc<T>, newItem: Item<T>, idx_hint: number = -1) => {
  const lastSeen = doc.version[newItem.id[0]] ?? -1
  if (newItem.id[1] !== lastSeen + 1) throw Error('Operations out of order')
  doc.version[newItem.id[0]] = newItem.id[1]

  let left = findItem(doc, newItem.originLeft, idx_hint - 1)
  let destIdx = left + 1
  let right = newItem.originRight == null ? doc.content.length : findItem(doc, newItem.originRight, idx_hint)
  let scanning = false

  for (let i = destIdx; ; i++) {
    if (!scanning) destIdx = i
    if (i === doc.content.length) break
    if (i === right) break

    let other = doc.content[i]

    // For the first "a":
    // `left == -1`, `right = 3 (doc.content.length)`
    // and `left == oleft && right == oright` (direct conflict)
    let oleft = findItem(doc, other.originLeft, idx_hint - 1)
    let oright = other.originRight == null ? doc.content.length : findItem(doc, other.originRight, idx_hint)

    // The logic below summarizes to:
    // if (oleft < left || (oleft === left && oright === right && newItem.id[0] < o.id[0])) break
    // if (oleft === left) scanning = oright < right

    if (oleft < left) {
      // For 2nd & 3rd "a"s we fall in here. Why?
      // 2nd "a":
      //    ∨ i points here (1)
      //  a b b b
      //  ^ left points here (0)
      // ^ oleft points here (-1)
      // 3rd "a"
      //      ∨ i points here (2)
      //  a a b b b
      // ^ oleft points here (-1)
      //    ^ left points here (1)
      //
      break
    } else if (oleft === left) {
      if (oright < right) {
        // This is tricky. We're looking at an item we *might* insert after - but we can't tell yet!
        scanning = true
        continue
      } else if (oright === right) {
        // For the 1st "a", we hit this case & win the tie breaker
        // ("A" < "B")
        if (newItem.id[0] < other.id[0]) break
        else {
          scanning = false
          continue
        }
      } else { // oright > right
        scanning = false
        continue
      }
    } else { // oleft > left
      continue
    }
  }

  // We've found the position. Insert here.
  doc.content.splice(destIdx, 0, newItem)
  if (!newItem.isDeleted) doc.length += 1
}

// VED: This is not used. This is a commented version of `integrateYjsMod` after I worked
// through the following cases:
// 1. "aaa" then "bbb"
// 2. "bbb" then "aaa"
// 3. "aaa" (right-to-left) then "bbb" (right-to-left)
// 4. "bbb" (right-to-left) then "aaa" (right-to-left)
const integrateYjsMod3 = <T>(doc: Doc<T>, newItem: Item<T>, idx_hint: number = -1) => {
  const lastSeen = doc.version[newItem.id[0]] ?? -1
  if (newItem.id[1] !== lastSeen + 1) throw Error('Operations out of order')
  doc.version[newItem.id[0]] = newItem.id[1]

  let left = findItem(doc, newItem.originLeft, idx_hint - 1)
  let destIdx = left + 1
  let right = newItem.originRight == null ? doc.content.length : findItem(doc, newItem.originRight, idx_hint)
  let scanning = false

  for (let i = destIdx; ; i++) {
    if (!scanning) destIdx = i
    // We've hit the end of the doc, we have to insert
    // hits:
    // a[1-3],b[1-3] in "aaa" (ltr), "bbb" (ltr)
    // b[1-3] in "bbb" (ltr), "aaa" (ltr). TODO(check)
    // a1/b1 in "aaa" (rtl) "bbb" (rtl). TODO(check)
    // not the 2nd or 3rd "a"s or "b"s b/c we are inserting them right-to-left
    // (so not at the end of the document)
    // b1 in "bbb" (rtl), "aaa" (rtl)
    if (i === doc.content.length) break
    // in "aaa" (rtl), "bbb" (rtl) we hit this case for a2/a3 and b2/b3
    // b2/b3 & a2/a3 in "bbb" (rtl) "aaa" (rtl)
    if (i === right) break

    let other = doc.content[i]

    let oleft = findItem(doc, other.originLeft, idx_hint - 1)
    let oright = other.originRight == null ? doc.content.length : findItem(doc, other.originRight, idx_hint)

    // if oright == right then oleft *must equal* left
    assert(oright !== right || oleft === oleft);

    // The logic below summarizes to:
    // if (oleft < left || (oleft === left && oright === right && newItem.id[0] < o.id[0])) break
    // if (oleft === left) scanning = oright < right

    // Deconstructing the above if statements:
    /*
    if (
      // Consider the document as a tree
      //   ROOT
      //  |   |
      //  a   b
      //      b
      //      b
      // we've hit the end of the "a" branch and `left` (our pred) is the first "a"
      // we've just encountered "b" (whose pred is ROOT), we want to insert at the
      // end of our branch
      // in array form:
      // a b b b
      //  | we are here
      oleft < left 
      // we've had a direct conflict (left & right bounds are the exact same)
      // *and* we win the conflict (we have a higher priority agent id, i.e "A" has higher priority than "B")
      // insert here
      || (oleft === left && oright === right && newItem.id[0] < o.id[0]))  {
        // insert item here
        break
    }
    // This is hard b/c I believe this is only for the right-to-left case,
    // so a tree doesn't cut it
    // if (oright < right) then we are in the middle of a rtl span, so set `scanning = true`
    // to preserve the current `destIdx` (we need to know whether to insert before/after this rtl span)
    // the current rtl span will end in 1 of 2 ways:
    // 1. `oright == right`: there's a direct conflict (oleft == left && oright == right),
    // (if oright == right then oleft *must equal* left, see the invariant check). We resolve the conflict & break (we
    // should insert before this rtl span),
    // or set scanning equal to false and skip past this rtl span.
    // 2. `oright > right`: we've reached the end of the current rtl span w/o ever hitting a direct conflict
    // (we know this is the case b/c previously oright < right but now it skipped to oright > right)
    // continue onwards to find the insertion point
    if (oleft === left) scanning = oright < right
    */

    if (oleft < left) {

      // hit: the 1st loop iteration for a2/a3 in "bbb" (ltr), "aaa" (ltr)
      // logical meaning: We are the continuation of a ltr span, so we need to
      // insert at the end of this ltr span but before the start of the next span
      // (which is also ltr??)
      break
    } else if (oleft === left) {
      if (oright < right) {
        // We have encountered a rtl span / are in the middle of it
        // but we don't know whether to insert before/after it
        // hit: "aaa" (rtl) "bbb" (rtl)
        // on the 1st/2nd loop iterations of b[1-3]
        // (on the 3rd iter of b1 we go to the tie breaker,
        // on the 3rd iter of b2/b3 we skip to `oright > right` indicating
        // we should move past the current span)
        // hit: "bbb" (rtl) "aaa" (rtl)
        // on the 1st/2nd loop iterations of a1
        // b/c `scanning = true`, we preserve `destIdx`
        // so when we win the tie breaker, we insert before the "b"s
        scanning = true
        continue
      } else if (oright === right) {
        // hits:
        // the first "b" in "aaa" (ltr), "bbb" (ltr)
        // the first "a" in "bbb" (ltr), "aaa" (ltr)
        // the first "b" in "aaa" (rtl) "bbb" (rtl)
        // a1 in "bbb" (rtl) "aaa" (rtl)
        if (newItem.id[0] < other.id[0]) break //CONFLICT
        else {
          // hits:
          // b1 in "aaa" (ltr), "bbb" (ltr)
          // b1 in "aaa" (rtl) "bbb" (rtl)
          // logical meaning: we've lost the tie breaker
          // if it was ambiguous whether we were going to insert
          // before/after a span (scanning == true), it is no longer
          // ambiguous, we will insert after
          scanning = false
          continue
        }
      } else { // oright > right
        // hits:
        // 3rd loop iteration of b2/b3 in "aaa" (rtl) "bbb" (rtl)
        // logical meaning: we've reached the end of the rtl span,
        // and we never reached a time where both `oleft === left && oright == right`
        // Instead, we skipped straight to `oright > right` which means we insert *after* this rtl span
        scanning = false
        continue
      }
    } else { // oleft > left
      // We are skipping a ltr span
      // Example: we're the first "b" in "aaa" (ltr), "bbb" (ltr)
      // We lose the //CONFLICT (no break), so we advance, but
      // our left is always the beginning of the doc while
      // the 2nd & 3rd "a" will have a left of 0, 1 respectively
      // so b2/b3 in this case go here
      continue
    }
  }

  // We've found the position. Insert here.
  doc.content.splice(destIdx, 0, newItem)
  if (!newItem.isDeleted) doc.length += 1
}


const integrateYjs = <T>(doc: Doc<T>, newItem: Item<T>, idx_hint: number = -1) => {
  const lastSeen = doc.version[newItem.id[0]] ?? -1
  if (newItem.id[1] !== lastSeen + 1) throw Error('Operations out of order')
  doc.version[newItem.id[0]] = newItem.id[1]

  let left = findItem(doc, newItem.originLeft, idx_hint - 1)
  let destIdx = left + 1
  let right = newItem.originRight == null ? doc.content.length : findItem(doc, newItem.originRight, idx_hint)
  let scanning = false

  for (let i = destIdx; ; i++) {
    // Inserting at the end of the document. Just insert.
    if (!scanning) destIdx = i
    if (i === doc.content.length) break
    if (i === right) break // No ambiguity / concurrency. Insert here.

    let other = doc.content[i]

    let oleft = findItem(doc, other.originLeft, idx_hint - 1)
    let oright = other.originRight == null ? doc.content.length : findItem(doc, other.originRight, idx_hint)

    // The logic below can be summarized in these two lines:
    // if (oleft < left || (oleft === left && oright === right && newItem.id[0] <= o.id[0])) break
    // if (oleft === left) scanning = newItem.id[0] <= o.id[0]

    // Ok now we implement the punnet square of behaviour
    if (oleft < left) {
      // Top row. Insert, insert, arbitrary (insert)
      break
    } else if (oleft === left) {
      // Middle row.
      if (newItem.id[0] > other.id[0]) {
        scanning = false
        continue
      } else if (oright === right) {
        break
      } else {
        scanning = true
        continue
      }
    } else {
      // Bottom row. Arbitrary (skip), skip, skip
      continue
    }
  }

  // We've found the position. Insert here.
  doc.content.splice(destIdx, 0, newItem)
  if (!newItem.isDeleted) doc.length += 1
}

const integrateAutomerge = <T>(
  doc: Doc<T>,
  newItem: Item<T>,
  idx_hint: number = -1
) => {
  const { id } = newItem;
  assert(newItem.seq >= 0);

  const lastSeen = doc.version[id[0]] ?? -1;
  if (id[1] !== lastSeen + 1) throw Error("Operations out of order");
  doc.version[id[0]] = id[1];

  // VED: `originLeft` = `elemId` in Automerge terminology
  // `findItem` maps elemId to a numerical index.
  // (We are getting the index of the predecessor/parent)
  const parent = findItem(doc, newItem.originLeft, idx_hint - 1);
  let destIdx = parent + 1;

  // Scan for the insert location. Stop if we reach the end of the document

  // VED: Unlike yjsMod, the terminating condition of (we hit the end of the list)
  // is in the for-loop bounds itself (`destIdx` < `doc.content.length`)
  // In "aaa" "bbb", for a[0-2] we terminate w/o ever entering
  // the loop. Same with b[1-2] (we find the parent, it will
  // be the last item in the doc, we break from the loop)

  // VED: For assertions
  let lostConflict = false;
  for (; destIdx < doc.content.length; destIdx++) {
    let o = doc.content[destIdx];

    // This is an unnecessary optimization (I couldn't help myself). It
    // doubles the speed when running the local editing traces by
    // avoiding calls to findItem() below. When newItem.seq > o.seq
    // we're guaranteed to end up falling into a branch that calls
    // break;.

    if (newItem.seq > o.seq) {
      // VED: Why does this optimization work?
      // There are 3 cases below:
      // oparent < parent (we break; the optimization works)
      // oparent == parent (we would enter the `newItem.seq > o.seq` case & break; the optimization works)
      // oparent > parent (this case only happens if `lostConflict == true`, but that only happens if
      // we enter `oparent == parent` & lose a conflict, which we won't b/c our seq number is higher)
      break;
    }

    // Optimization: This call halves the speed of this automerge
    // implementation. Its only needed to see if o.originLeft has been
    // visited in this loop, which we could calculate much more
    // efficiently.

    // VED: Get the index of the parent of other
    // For b[0] in "aaa" "bbb", parent = -1
    // oparent goes -1, 0, 1
    let oparent = findItem(doc, o.originLeft, idx_hint - 1);

    // All the logic below can be expressed in this single line:
    // if (oparent < parent || (oparent === parent && (newItem.seq === o.seq) && id[0] < o.id[0])) break

    // Ok now we implement the punnet square of behaviour
    if (oparent < parent) {
      // VED: We've gotten to the end of the list of children. Stop here.
      // When disabling the optimization we enter this branch on the 1st loop iter of b1/b2 (remember b0 is the first "b" that is inserted)
      // Visualization:
      // Automerge is a tree. We're encoding the tree as a list.
      //     ROOT
      //   |    |
      //   a    b
      //        b
      //        b
      // We want to insert the 2nd "a"
      // The list looks like [a b b b ]
      // When we encounter the 1st b, we it's pred will be ROOT (and if our pred is > ROOT, this means we're at the tip of a branch,
      // so we should insert)
      // This works b/c `const parent = findItem(...)` will put us at the end of our child branch
      // so, we don't need to worry about a scenario where
      //  ROOT
      //  |   |
      //  a   b
      //  a   b
      //      b
      // where we will start after the 1st "a" (which as pred = ROOT), even though we are the 3rd "a"
      // and should start after the 2nd "a"
      break;
    } else if (oparent === parent) {
      // VED: For b[0] in "aaa" "bbb" we enter here
      // Both items have the same parent. There's a conflict

      // Concurrent items from different useragents are sorted first by seq then agent.

      // NOTE: For consistency with the other algorithms, adjacent items
      // are sorted in *ascending* order of useragent rather than
      // *descending* order as in the actual automerge. It doesn't
      // matter for correctness, but its something to keep in mind if
      // compatibility matters. The reference checker inverts AM client
      // ids.

      // Inverted item sequence number comparisons are used in place of originRight for AM.
      if (newItem.seq > o.seq) {
        // The new item has a higher seq, we win the conflict (get inserted immediately)
        break;
      } else if (newItem.seq === o.seq) {
        // The seqs are the same, we tie break based on agent
        // if we win, we `break` (get inserted immediately)
        if (id[0] < o.id[0]) break;
        else {
          lostConflict = true;
          continue;
        }
      } else {
        lostConflict = true;
        continue;
      }
    } else { // oparent > parent
      // VED: This assertion shows that we only enter this branch
      // if we *lost* a conflict & are skipping over the children in that branch
      assert(lostConflict);
      // Skip child
      // VED: For b[0] in "aaa" "bbb" we first hit `oparent === parent` (hard conflict)
      // and then enter this case twice since oparent increases while parent is constant
      // (In reference to the original Automerge paper, we are skipping past a child
      // branch in the tree)
      continue;
    }
  }

  if (newItem.seq > doc.maxSeq) doc.maxSeq = newItem.seq;

  // We've found the position. Insert here.
  doc.content.splice(destIdx, 0, newItem);
  if (!newItem.isDeleted) doc.length += 1;
};


const integrateSync9 = <T>(doc: Doc<T>, newItem: Item<T>, idx_hint: number = -1) => {
  const {id: [agent, seq]} = newItem
  const lastSeen = doc.version[agent] ?? -1
  if (seq !== lastSeen + 1) throw Error('Operations out of order')
  doc.version[agent] = seq

  let parentIdx = findItem2(doc, newItem.originLeft, newItem.insertAfter, idx_hint - 1)
  let destIdx = parentIdx + 1

  // if (parentIdx >= 0 && newItem.originLeft && (newItem.originLeft[1] === doc.content[parentIdx].id[1]) && doc.content[parentIdx].content != null) {
  if (parentIdx >= 0 && newItem.originLeft && !newItem.insertAfter && doc.content[parentIdx].content != null) {
    // Split left item to add null content item to the set
    doc.content.splice(parentIdx, 0, {
      ...doc.content[parentIdx],
      content: null
    })
    // We can skip the loop because we know we're an only child.

  } else {
    for (; destIdx < doc.content.length; destIdx++) {
      let other = doc.content[destIdx]
      // We still need to skip children of originLeft.
      let oparentIdx = findItem2(doc, other.originLeft, other.insertAfter, idx_hint - 1)

      if (oparentIdx < parentIdx) break
      else if (oparentIdx === parentIdx) {
        // if (!idEq(other.originLeft, newItem.originLeft)) break
        if (newItem.id[0] < other.id[0]) break
        else continue
      } else continue
    }
  }

  // We've found the position. Insert here.
  doc.content.splice(destIdx, 0, newItem)
  if (!newItem.isDeleted && newItem.content != null) doc.length += 1
}

export const sync9: Algorithm = {
  localInsert: localInsertSync9,
  integrate: integrateSync9,
  printDoc(doc) { printdoc(doc, false, false, true) },
}

export const yjsMod: Algorithm = {
  localInsert,
  integrate: integrateYjsMod,
  printDoc(doc) { printdoc(doc, false, true, false) },
}

export const yjs: Algorithm = {
  localInsert,
  integrate: integrateYjs,
  printDoc(doc) { printdoc(doc, false, true, false) },

  ignoreTests: ['withTails2']
}

export const automerge: Algorithm = {
  localInsert,
  integrate: integrateAutomerge,
  printDoc(doc) { printdoc(doc, true, false, false) },

  // Automerge doesn't handle these cases as I would expect.
  ignoreTests: [
    'interleavingBackward',
    'interleavingBackward2',
    'withTails',
    'withTails2'
  ]
}

export const printDebugStats = () => {
  console.log('hits', hits, 'misses', misses)
}


// ;(() => {
//   console.clear()

//   const alg = sync9

//   let doc1 = newDoc()

//   alg.localInsert(doc1, 'a', 0, 'x')
//   alg.localInsert(doc1, 'a', 1, 'y')
//   alg.localInsert(doc1, 'a', 0, 'z')

//   // alg.printDoc(doc1)

//   let doc2 = newDoc()

//   alg.localInsert(doc2, 'b', 0, 'a')
//   alg.localInsert(doc2, 'b', 1, 'b')
//   // alg.localInsert(doc2, 'b', 2, 'c')

//   mergeInto(alg, doc1, doc2)

//   alg.printDoc(doc1)

//   console.log('\n\n\n')
// })()
