# Security

ChangeKeeper reads and rewrites files in your workspace on your request (discard, restore) and keeps copies of changed files in VS Code's global storage. Please report anything that could make it write to the wrong file, write without a user action, lose a baseline it promised to keep, leak stored content, or be tricked by workspace content (paths, symlinks, git configuration):

- Email: info@tecniartgalicia.com (subject "changekeeper security")
- Or a private security advisory on GitHub.

We aim to acknowledge within 3 business days. Please don't open public issues for security reports until a fix is released.
