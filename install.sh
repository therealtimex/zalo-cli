#!/bin/bash
# @realtimex/zalo-cli One-Command Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/therealtimex/zalo-cli/main/install.sh | bash

set -e

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0;37m' # No Color

echo -e "${BLUE}=== @realtimex/zalo-cli Installer ===${NC}"
echo "Checking environment..."

# 1. Check if Node.js is installed
if ! command -v node >/dev/null 2>&1; then
    echo -e "${RED}Error: Node.js is not installed.${NC}"
    echo "Please install Node.js (v20 or newer) to run @realtimex/zalo-cli."
    echo -e "You can install it via your package manager or from: ${BLUE}https://nodejs.org/${NC}"
    exit 1
fi

# 2. Check Node.js version (min v20)
NODE_VERSION=$(node -v | cut -d'v' -f2)
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d'.' -f1)

if [ "$NODE_MAJOR" -lt 20 ]; then
    echo -e "${RED}Error: Node.js version $NODE_VERSION is too old.${NC}"
    echo "@realtimex/zalo-cli requires Node.js v20 or newer."
    echo "Please upgrade your Node.js installation."
    exit 1
fi

echo -e "Node.js detected: ${GREEN}v$NODE_VERSION${NC}"

# 3. Check for npm
if ! command -v npm >/dev/null 2>&1; then
    echo -e "${RED}Error: npm (Node Package Manager) is not installed.${NC}"
    echo "Please install npm to continue."
    exit 1
fi

# 4. Perform global install
echo "Installing @realtimex/zalo-cli globally..."

install_cmd="npm install -g @realtimex/zalo-cli@latest"

# Try running without sudo first
if $install_cmd; then
    echo -e "${GREEN}Installation successful!${NC}"
else
    echo -e "${YELLOW}Global installation failed. Retrying with sudo...${NC}"
    if command -v sudo >/dev/null 2>&1; then
        if sudo $install_cmd; then
            echo -e "${GREEN}Installation successful (via sudo)!${NC}"
        else
            echo -e "${RED}Error: Installation failed even with sudo.${NC}"
            exit 1
        fi
    else
        echo -e "${RED}Error: sudo is not available, and non-root installation failed.${NC}"
        exit 1
    fi
fi

echo -e "\n${GREEN}=== Success! ===${NC}"
echo "@realtimex/zalo-cli has been successfully installed."
echo -e "Run ${BLUE}zalo-agent login${NC} to authenticate your Zalo account and get started!"
