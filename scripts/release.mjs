#!/usr/bin/env node
// Cuts a release: verify -> bump version -> tag -> push tag. Pushing the tag is
// what triggers .github/workflows/release.yml, which builds all three platforms
// and uploads them into a draft GitHub Release.
//
// The tree must be clean because `npm version` commits, and a dirty tree would
// silently sweep unrelated work into the version commit.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const capture = args =>
  execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe' }).trim()

const git = args => execFileSync('git', args, { stdio: 'inherit' })
const npm = args =>
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    stdio: 'inherit',
  })

const bump = process.argv[2] ?? 'patch'
const allowed = ['patch', 'minor', 'major']
if (!allowed.includes(bump) && !/^\d+\.\d+\.\d+/.test(bump)) {
  console.error(`usage: npm run release [${allowed.join('|')}|<explicit version>]`)
  process.exit(1)
}

if (capture(['status', '--porcelain'])) {
  console.error('working tree is dirty - commit or stash first (npm run ship -- "...")')
  process.exit(1)
}

const branch = capture(['rev-parse', '--abbrev-ref', 'HEAD'])
if (branch !== 'main') {
  console.error(`releases are cut from main, not "${branch}"`)
  process.exit(1)
}

// A tag pushed ahead of its commits would build a ref GitHub does not have.
git(['fetch', 'origin', 'main'])
if (capture(['rev-list', '--count', 'origin/main..HEAD']) !== '0') {
  console.error('local commits are not pushed - run `npm run ship` first')
  process.exit(1)
}

console.log('\n--- verifying ---')
npm(['run', 'typecheck'])
npm(['test'])

console.log(`\n--- bumping (${bump}) ---`)
npm(['version', bump, '-m', 'chore: release v%s'])

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
git(['push', '--follow-tags', 'origin', 'main'])

console.log(`\nreleased v${version}`)
console.log('CI is now building linux/win/mac into a DRAFT release.')
console.log('Publish the draft on GitHub to make the in-app updater see it:')
console.log('  gh release list')
console.log(`  gh release edit v${version} --draft=false`)
