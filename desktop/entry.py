"""PyInstaller entry point; no host activation on application launch."""
from grokctl.desktop import main

if __name__ == "__main__":
    raise SystemExit(main())
