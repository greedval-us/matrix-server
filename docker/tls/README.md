Place the future deployment's `server.crt` and `server.key` here, or set
`MATRIX_TLS_DIR` to an existing absolute directory outside the checkout.
Never commit certificates or private keys. On Linux the API runs as uid/gid
1000 (`node`); give that user read access to the key without making it public
(for example root:1000 with mode 0640, directory 0750).
See ../../docs/deployment.md for LAN/TLS setup.
