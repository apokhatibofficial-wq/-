# Hospital Windows app (.NET 8 WPF)
Phases 7–8: SQLite + SQLCipher (key protected with DPAPI under `%LOCALAPPDATA%\MEDLINK\`), outbox sync, MSIX, Ed25519-verified updates.
Design: `docs/design/designs/Windows App.dc.html`. Sign-in already works against the API with `{"client":"windows"}`, which returns a bearer token.
