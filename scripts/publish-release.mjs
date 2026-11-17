import { parseArgs } from 'node:util'
import { publishRelease } from '../node/modules/releases/publish.mjs'

try {
  const { values } = parseArgs({ options: Object.fromEntries(['file', 'directory', 'version', 'platform', 'arch', 'kind', 'notes'].map(name => [name, { type: 'string' }])) })
  const release = await publishRelease({ ...values, directory: values.directory ?? process.env.MATRIX_RELEASES_DIR ?? 'data/releases' })
  console.log(JSON.stringify(release, null, 2))
} catch (error) {
  console.error(error?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || error?.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE'
    ? 'Usage: npm run release:publish -- --file <application> --version <x.y.z> --platform <win32|linux> --arch <x64|arm64|ia32> --kind <portable|appimage> [--directory <path>] [--notes <text>]'
    : error.message)
  process.exitCode = 1
}
