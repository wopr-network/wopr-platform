#!/usr/bin/env bash
set -euo pipefail

PLATFORM_URL="${PLATFORM_URL:-https://api.wopr.bot}"
REGISTRATION_TOKEN="${1:-}"

if [ -z "$REGISTRATION_TOKEN" ]; then
  echo "Usage: curl -sSL https://install.wopr.bot/agent | bash -s -- <REGISTRATION_TOKEN>"
  echo "  Get a registration token from your WOPR dashboard: Settings > Hardware > Add Node"
  exit 1
fi

echo "==> Installing WOPR Node Agent..."

# Detect OS
OS=$(uname -s | tr '[:upper:]' '[:lower:]')

# Check prerequisites
command -v docker >/dev/null 2>&1 || {
  echo "ERROR: Docker is required. Install it first: https://docs.docker.com/get-docker/"
  exit 1
}
command -v node >/dev/null 2>&1 || {
  echo "ERROR: Node.js 24+ is required. Install it first: https://nodejs.org/"
  exit 1
}

# Install the agent globally
echo "==> Installing @wopr-network/node-agent..."
npm install -g @wopr-network/node-agent

# Create config directory
sudo mkdir -p /etc/wopr
sudo chown "$(whoami)" /etc/wopr

# Create backup directory
sudo mkdir -p /var/wopr/backups
sudo chown "$(whoami)" /var/wopr/backups

# Write initial env config
cat > /etc/wopr/agent.env <<EOF
PLATFORM_URL=${PLATFORM_URL}
REGISTRATION_TOKEN=${REGISTRATION_TOKEN}
CREDENTIALS_PATH=/etc/wopr/credentials.json
BACKUP_DIR=/var/wopr/backups
EOF

# Create systemd service (Linux only)
if [ "$OS" = "linux" ] && command -v systemctl >/dev/null 2>&1; then
  echo "==> Creating systemd service..."
  sudo tee /etc/systemd/system/wopr-agent.service > /dev/null <<SVCEOF
[Unit]
Description=WOPR Node Agent
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
EnvironmentFile=/etc/wopr/agent.env
ExecStart=$(which wopr-agent)
Restart=always
RestartSec=5
User=$(whoami)

[Install]
WantedBy=multi-user.target
SVCEOF

  sudo systemctl daemon-reload
  sudo systemctl enable wopr-agent
  sudo systemctl start wopr-agent

  echo "==> WOPR Node Agent installed and started!"
  echo "    Check status: systemctl status wopr-agent"
  echo "    View logs:    journalctl -u wopr-agent -f"

elif [ "$OS" = "darwin" ]; then
  # macOS: create launchd plist
  echo "==> Creating launchd service..."
  PLIST_PATH="$HOME/Library/LaunchAgents/bot.wopr.agent.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST_PATH" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>bot.wopr.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(which wopr-agent)</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PLATFORM_URL</key>
    <string>${PLATFORM_URL}</string>
    <key>REGISTRATION_TOKEN</key>
    <string>${REGISTRATION_TOKEN}</string>
    <key>CREDENTIALS_PATH</key>
    <string>/etc/wopr/credentials.json</string>
    <key>BACKUP_DIR</key>
    <string>/var/wopr/backups</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/wopr-agent.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/wopr-agent.err</string>
</dict>
</plist>
PLISTEOF

  launchctl load "$PLIST_PATH"

  echo "==> WOPR Node Agent installed and started!"
  echo "    Check status: launchctl list | grep wopr"
  echo "    View logs:    tail -f /tmp/wopr-agent.log"

else
  echo "==> WOPR Node Agent installed!"
  echo "    Run manually: REGISTRATION_TOKEN=${REGISTRATION_TOKEN} PLATFORM_URL=${PLATFORM_URL} wopr-agent"
fi

echo ""
echo "Your node will appear in the WOPR dashboard within 30 seconds."
