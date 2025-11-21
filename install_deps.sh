#!/bin/bash

# Detect operating system and architecture
detect_platform() {
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  ARCH=$(uname -m)
  
  case "$OS" in
    linux)
      case "$ARCH" in
        x86_64) echo "linux-amd64" ;;
        *) echo "unsupported" ;;
      esac
      ;;
    darwin)
      case "$ARCH" in
        x86_64) echo "mac-amd64" ;;
        arm64) echo "mac-arm64" ;;
        *) echo "unsupported" ;;
      esac
      ;;
    *)
      echo "unsupported"
      ;;
  esac
}

# Check if current directory is YASA-Engine root
check_directory() {
  if [ ! -f "package.json" ]; then
    echo "[ERROR] This script must be run from the root directory of the YASA-Engine repository."
    echo "Please navigate to the YASA-Engine directory and try again."
    exit 1
  fi
}

# Download binary files
download_binaries() {
  PLATFORM=$1

  echo "[INFO] Downloading latest release binaries for platform: $PLATFORM..."

  # Create target directories
  mkdir -p deps/uast4go deps/uast4py

  # Define binaries and target paths
  BINARIES=("uast4go-$PLATFORM" "uast4py-$PLATFORM")
  TARGET_PATHS=("deps/uast4go/uast4go" "deps/uast4py/uast4py")

  for i in "${!BINARIES[@]}"; do
    BINARY=${BINARIES[$i]}
    TARGET=${TARGET_PATHS[$i]}
    DOWNLOAD_URL="https://github.com/antgroup/YASA-UAST/releases/latest/download/${BINARY}"

    echo "[INFO] Downloading $BINARY to $TARGET..."

    # Download the binary
    curl -L -f -o "$TARGET" "$DOWNLOAD_URL" || {
      echo "[ERROR] Failed to download $BINARY"; 
      exit 1;
    }

    # Make the binary executable
    chmod +x "$TARGET"
  done
}

# Main build process
main() {
  echo "[INFO] Starting YASA-Engine build process..."

  # Check if in the correct directory
  check_directory

  # Detect platform
  PLATFORM=$(detect_platform)
  if [ "$PLATFORM" = "unsupported" ]; then
    echo "[ERROR] Unsupported platform: $(uname -s)-$(uname -m)"
    exit 1
  fi
  echo "[INFO] Detected platform: $PLATFORM"

  # Install dependencies
  echo "[INFO] Installing dependencies..."
  npm install || { echo "[ERROR] npm install failed"; exit 1; }

  # Download binary files
  echo "[INFO] Downloading required binaries..."
  download_binaries "$PLATFORM"

  echo "[INFO] Build completed successfully."
}

main "$@"