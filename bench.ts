import zlib from 'zlib'
import fs from 'fs'
import {Algorithm, newDoc, localDelete, yjsMod, automerge, getArray, sync9} from './crdts'
import assert from 'assert'

const bench = (algName: string, alg: Algorithm) => {
  // const filename = 'sveltecomponent'
  const filename = 'automerge-paper'
  const {
    startContent,
    endContent,
    txns
  } = JSON.parse(zlib.gunzipSync(fs.readFileSync(`../crdt-benchmarks/${filename}.json.gz`)).toString())

  console.time(`${algName} ${filename}`)
  const doc = newDoc()

  let i = 0
  for (const txn of txns) {
    if (++i % 10000 === 0) console.log(i)
    for (const patch of txn.patches) {
      // Ignoring any deletes for now.
      const [pos, delCount, inserted] = patch as [number, number, string]
      if (inserted.length) {
        alg.localInsert(doc, 'A', pos, inserted)
      } else if (delCount) {
        localDelete(doc, 'A', pos)
      }
    }
  }
  console.timeEnd(`${algName} ${filename}`)

  assert.strictEqual(getArray(doc).join(''), endContent)
}

bench('yjs mod', yjsMod)
bench('automerge', automerge)
bench('sync9', sync9)
