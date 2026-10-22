# Security

WorkWire is early-stage software for operator-owned machines on a trusted LAN.
The recovery plane can execute commands as root or LocalSystem. Only pair
machines and operators you trust, protect pairing material, and keep service
ports behind your LAN firewall. Do not expose WorkWire services directly to
the internet. Start with disposable data and maintain independent backups.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/hinoki-ai/WorkWire/security/advisories/new).
Do not post credentials, exploit details, or private machine data in a public
issue. Include the affected commit, impact, and a minimal reproduction using
synthetic data. Remove secrets from logs and screenshots.

Security fixes currently target the latest main branch. There is no long-term
support policy or guaranteed response time. The initial public preview is not
a production-readiness certification.
