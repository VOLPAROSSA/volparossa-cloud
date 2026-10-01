# VOLPAROSSA Cloud

- Integrate OpenCloud with the shared VOLPAROSSA core; do not create a separate
  peer scheduler, storage ledger, identity authority or redundancy setting.
- Preserve ordinary OpenCloud accounts, file access and sharing. Offline access
  must not silently grant rights that an online server would refuse.
- Private file bytes, names, directory catalogs, versions, search indexes and
  previews remain private. Do not publish them in the public cache or use them
  as training data. Storage peers receive application-encrypted objects only.
- A backup connector or distributed blob store is not a server-independent
  OpenCloud service. Track authentication, metadata, synchronization, conflicts,
  permissions and client compatibility separately; document missing behavior.
- New storage follows the core's single redundancy policy. Preserve existing
  archives and charges; never delete the last recoverable copy during migration.
- Use small, executable slices and targeted functional checks. Prove origin-off
  access with the real supported client before claiming it works without the
  original server. Never replace such evidence with a mock-only claim.
- Use synthetic data for tests. Do not change host networking, install global
  software, download executable dependencies automatically, or read real user
  accounts/files without a specific request.
- Pin upstream source and preserve component licenses. Original integration
  code is GPL-3.0-only; OpenCloud server and web components have distinct licenses.
