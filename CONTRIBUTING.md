# Contributing to WorkWire

Bug reports, documentation fixes, and focused pull requests are welcome.
For a larger feature, open an issue first to discuss the problem and scope.

## Development

Use Node.js 22 or newer and npm. Work in a separate clone with disposable
files, not a checkout running a live WorkWire service.

```sh
git clone https://github.com/hinoki-ai/WorkWire.git
cd WorkWire
npm ci --ignore-scripts
npm test
```

`--ignore-scripts` skips the project installer and dependency install hooks.
For desktop development, download Electron explicitly afterward:

```sh
node node_modules/electron/install.js
npm start
```

Linux is the primary source-development environment. Windows recovery-agent
support is documented in [docs/RECOVERY.md](docs/RECOVERY.md). The automated
Linux suite does not establish physical Windows or recovery-image support.

## Pull requests

Explain the problem, resulting behavior, and verification you actually ran.
Add focused regression coverage for behavior changes. Keep unrelated changes
out of the pull request. Never submit credentials, pairing files, personal
files, runtime state, installers, or mirror-conflict copies.

Fleet tests can control machines and alter files. Run them only against your
own explicitly configured disposable fixtures. Do not use the maintainer's
machine names, paths, or identities from operational documents.

Contributions are provided under the project's MIT license. Preserve existing
third-party copyright and license notices. Be respectful, assume good intent,
and keep discussion focused on the work.
