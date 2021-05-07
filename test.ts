import assert from 'assert/strict'
import seed from 'seed-random'


type Id = [agent: string, seq: number]
type Version = Record<string, number> // Last seen seq for each agent.

// type Id = {
//   agent: string,
//   seq: number,
// }

type Item<T> = {
  content: T,
  id: Id,

  // Left and right implicit in document list.
  // null represents document's root / end.
  originLeft: Id | null,
  originRight: Id | null,

  isDeleted: boolean,
}

interface Doc<T = string> {
  content: Item<T>[]
  version: Version // agent => last seen seq.
}

const newDoc = <T>(): Doc<T> => ({content: [], version: {}})

const idEq = (a: Id | null, b: Id | null): boolean => (
  a === b || (a != null && b != null && a[0] === b[0] && a[1] === b[1])
)

const findItem = <T>(doc: Doc<T>, needle: Id | null): number => {
  if (needle == null) return -1
  else {
    const idx = doc.content.findIndex(({id}) => idEq(id, needle))
    if (idx < 0) throw Error('Could not find item') // Could use a ternary if not for this!
    return idx
  }
}

const integrate = <T>(doc: Doc<T>, newItem: Item<T>) => {
  const lastSeen = doc.version[newItem.id[0]] ?? -1
  if (newItem.id[1] !== lastSeen + 1) throw Error('Operations out of order')
  doc.version[newItem.id[0]] = newItem.id[1]

  let left = findItem(doc, newItem.originLeft)
  let destIdx = left + 1
  let right = newItem.originRight == null ? doc.content.length : findItem(doc, newItem.originRight)
  let conflictStart = -1

  const startConflict = (i: number) => conflictStart = i
  const resetConflict = () => conflictStart = -1

  for (let i = destIdx; ; i++) {
    // Inserting at the end of the document. Just insert.
    if (conflictStart === -1) destIdx = i
    if (i === doc.content.length) break
    if (i === right) break // No ambiguity / concurrency. Insert here.

    let o = doc.content[i]

    let oleft = findItem(doc, o.originLeft)
    let oright = o.originRight == null ? doc.content.length : findItem(doc, o.originRight)

    // Ok now we implement the punnet square of behaviour
    if (oleft < left) {
      // Top row. Insert, insert, arbitrary (insert)
      // I'm not sure a conflict is a problem here, but I can't generate one with my tests!
      if (conflictStart >= 0) throw Error('Unexpected conflict')
      break
    } else if (oleft === left) {
      // Middle row.
      if (oright < right) {
        // This is tricky. We're looking at an item we *might* insert after - but we can't tell yet!
        startConflict(i)
        continue
      } else if (oright === right) {
        // Raw conflict. Order based on user agents.
        resetConflict()
        if (newItem.id[0] < o.id[0]) break
        else {
          continue
        }
      } else {
        resetConflict()
        continue
      }
    } else {
      // Bottom row. Arbitrary (skip), skip, skip
      continue
    }
  }

  // We've found the position. Insert here.
  doc.content.splice(destIdx, 0, newItem)
}

const getNextSeq = <T>(doc: Doc<T>, agent: string): number => {
  const last = doc.version[agent]
  return last == null ? 0 : last + 1
}

const localInsert = <T>(doc: Doc<T>, agent: string, pos: number, content: T) => {
  const op = makeItem(
    content,
    [agent, (doc.version[agent] ?? -1) + 1],
    doc.content[pos - 1]?.id ?? null,
    doc.content[pos]?.id ?? null
  )
  integrate(doc, op)
}

// const makeItemAt = <T>(doc: Doc<T>, pos: number, content: T, agent: string, seq?: number, originLeft?: Id | null, originRight?: Id | null): Item<T> => ({
//   content,
//   id: [agent, seq ?? getNextSeq(doc, agent)],
//   isDeleted: false,
//   originLeft: originLeft ?? (pos === 0 ? null : doc.content[pos - 1].id),
//   originRight: originRight ?? (pos >= doc.content.length ? null : doc.content[pos].id)
// })

const makeItem = <T>(content: T, idOrAgent: string | Id, originLeft: Id | null, originRight: Id | null): Item<T> => ({
  content,
  id: typeof idOrAgent === 'string' ? [idOrAgent, 0] : idOrAgent,
  isDeleted: false,
  originLeft,
  originRight
})

const getArray = <T>(doc: Doc<T>): T[] => (
  doc.content.map(i => i.content)
)

const isInVersion = (id: Id | null, version: Version) => {
  if (id == null) return true
  const seq = version[id[0]]
  return seq != null && seq >= id[1]
}

const canInsertNow = <T>(op: Item<T>, doc: Doc<T>): boolean => (
  // We need op.id to not be in doc.versions, but originLeft and originRight to be in.
  // We're also inserting each item from each agent in sequence.
  !isInVersion(op.id, doc.version)
    && (op.id[1] === 0 || isInVersion([op.id[0], op.id[1] - 1], doc.version))
    && isInVersion(op.originLeft, doc.version)
    && isInVersion(op.originRight, doc.version)
)

// Merge all missing items from src into dest.
const mergeInto = <T>(dest: Doc<T>, src: Doc<T>) => {
  // The list of operations we need to integrate
  const missing: (Item<T> | null)[] = src.content.filter(op => !isInVersion(op.id, dest.version))
  let remaining = missing.length

  while (remaining > 0) {
    // Find the next item in remaining and insert it.
    let mergedOnThisPass = 0

    for (let i = 0; i < missing.length; i++) {
      const op = missing[i]
      if (op == null || !canInsertNow(op, dest)) continue
      integrate(dest, op)
      missing[i] = null
      remaining--
      mergedOnThisPass++
    }

    assert(mergedOnThisPass)
  }
}


/// TESTS

;(() => { // Separate scope for namespace protection.
  const random = seed('ax')
  const randInt = (n: number) => Math.floor(random() * n)
  const randArrItem = (arr: any[] | string) => arr[randInt(arr.length)]
  const randBool = (weight: number = 0.5) => random() < weight

  const integrateFuzzOnce = <T>(ops: Item<T>[], expectedResult: T[]): number => {
    let variants = 1
    const doc = newDoc()

    // Scan ops looking for candidates to integrate
    for (let numIntegrated = 0; numIntegrated < ops.length; numIntegrated++) {
      const candidates = []
      for (const op of ops) {
        if (canInsertNow(op, doc)) {
          candidates.push(op)

          // console.log(op.id, doc.version, isInVersion(op.id, doc.version))
        }
      }
      assert(candidates.length > 0)
      variants *= candidates.length
      // console.log('doc version', doc.version, 'candidates', candidates)

      // Pick one
      const op = candidates[randInt(candidates.length)]
      // console.log(op, doc.version)
      integrate(doc, op)
    }

    assert.deepStrictEqual(getArray(doc), expectedResult)
    // console.log(variants)
    return variants // Rough guess at the number of orderings
  }


  const integrateFuzz = <T>(ops: Item<T>[], expectedResult: T[]) => {
    // Integrate the passed items a bunch of times, in different orders.
    let variants = integrateFuzzOnce(ops, expectedResult)
    for (let i = 1; i < Math.min(variants * 3, 100); i++) {
      let newVariants = integrateFuzzOnce(ops, expectedResult)
      variants = Math.max(variants, newVariants)
    }
  }

  const test = (fn: () => void) => {
    process.stdout.write(`running ${fn.name} ...`)
    fn()
    process.stdout.write(`PASS\n`)
  }

  const smoke = () => {
    const doc = newDoc()
    integrate(doc, makeItem('a', ['A', 0], null, null))
    integrate(doc, makeItem('b', ['A', 1], ['A', 0], null))

    assert.deepEqual(getArray(doc), ['a', 'b'])
  }

  const smokeMerge = () => {
    const doc = newDoc()
    integrate(doc, makeItem('a', ['A', 0], null, null))
    integrate(doc, makeItem('b', ['A', 1], ['A', 0], null))

    const doc2 = newDoc()
    mergeInto(doc2, doc)
    assert.deepEqual(getArray(doc2), ['a', 'b'])
  }

  const concurrentAvsB = () => {
    const a = makeItem('a', 'A', null, null)
    const b = makeItem('b', 'B', null, null)
    integrateFuzz([a, b], ['a', 'b'])
  }

  const interleavingForward = () => {
    const ops = [
      makeItem('a', ['A', 0], null, null),
      makeItem('a', ['A', 1], ['A', 0], null),
      makeItem('a', ['A', 2], ['A', 1], null),

      makeItem('b', ['B', 0], null, null),
      makeItem('b', ['B', 1], ['B', 0], null),
      makeItem('b', ['B', 2], ['B', 1], null),
    ]

    integrateFuzz(ops, ['a', 'a', 'a', 'b', 'b', 'b'])
  }

  const interleavingBackward = () => {
    const ops = [
      makeItem('a', ['A', 0], null, null),
      makeItem('a', ['A', 1], null, ['A', 0]),
      makeItem('a', ['A', 2], null, ['A', 1]),

      makeItem('b', ['B', 0], null, null),
      makeItem('b', ['B', 1], null, ['B', 0]),
      makeItem('b', ['B', 2], null, ['B', 1]),
    ]

    integrateFuzz(ops, ['a', 'a', 'a', 'b', 'b', 'b'])
  }

  const withTails = () => {
    const ops = [
      makeItem('a', ['A', 0], null, null),
      makeItem('a0', ['A', 1], null, ['A', 0]), // left
      makeItem('a1', ['A', 2], ['A', 0], null), // right

      makeItem('b', ['B', 0], null, null),
      makeItem('b0', ['B', 1], null, ['B', 0]), // left
      makeItem('b1', ['B', 2], ['B', 0], null), // right
    ]

    integrateFuzz(ops, ['a0', 'a', 'a1', 'b0', 'b', 'b1'])
  }

  const localVsConcurrent = () => {
    // Check what happens when a top level concurrent change interacts
    // with a more localised change. (C vs D)
    const a = makeItem('a', 'A', null, null)
    const c = makeItem('c', 'C', null, null)

    // How do these two get ordered?
    const b = makeItem('b', 'B', null, null) // Concurrent with a and c
    const d = makeItem('d', 'D', ['A', 0], ['C', 0]) // in between a and c

    // [a, b, d, c] would also be acceptable.
    integrateFuzz([a, b, c, d], ['a', 'd', 'b', 'c'])
  }

  const fuzzSequential = () => {
    const doc = newDoc()
    let expectedContent: string[] = []
    const alphabet = 'xyz123'
    const agents = 'ABCDE'

    for (let i = 0; i < 1000; i++) {
      const pos = randInt(doc.content.length + 1)
      const content: string = randArrItem(alphabet)
      const agent = randArrItem(agents)
      localInsert(doc, agent, pos, content)
      expectedContent.splice(pos, 0, content)

      assert.deepStrictEqual(getArray(doc), expectedContent)
    }
  }

  const fuzzMultidoc = () => {
    const agents = ['A', 'B', 'C']
    const docs = new Array(3).fill(null).map((_, i) => {
      const doc: Doc<number> & {agent: string} = newDoc() as any
      doc.agent = agents[i]
      return doc
    })

    const randDoc = () => docs[randInt(docs.length)]

    let nextItem = 0
    // console.log(docs)
    for (let i = 0; i < 1000; i++) {
      // console.log(i)
      if (i % 100 === 0) console.log(i)

      // Generate some random operations
      for (let j = 0; j < 3; j++) {
        const doc = randDoc()

        const len = doc.content.length
        const content = ++nextItem
        const pos = randInt(len + 1)
        localInsert(doc, doc.agent, pos, content)
      }

      // Pick a pair of documents and merge them
      const a = randDoc()
      const b = randDoc()
      if (a !== b) {
        // console.log('merging', a.id, b.id, a.content, b.content)
        mergeInto(a, b)
        mergeInto(b, a)
        assert.deepStrictEqual(getArray(a), getArray(b))
      }
    }
  }


  const tests = [
    smoke,
    smokeMerge,
    concurrentAvsB,
    interleavingForward,
    interleavingBackward,
    withTails,
    localVsConcurrent,
    fuzzSequential,
    fuzzMultidoc
  ]
  tests.forEach(test)

})()