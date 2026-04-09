# Raspberry Pi SD Card Preparation

## Files to Copy to SD Card

This directory contains all the files you need to copy to your Raspberry Pi 3B+ SD card.

### Instructions

#### 1. Download Raspberry Pi OS Lite

Download from: https://www.raspberrypi.com/software/operating-systems/

- Choose "Raspberry Pi OS Lite (32-bit)"

#### 2. Flash the SD Card

Use balenaEtcher: https://www.balena.io/etcher/

#### 3. Copy These Files to the Boot Partition

After flashing, you'll see a drive called "boot". Copy:

```
/sd-card/
├── config.txt           # Enable UART and settings
├── firstrun.sh          # Auto-setup script (runs on first boot)
└── user-data.txt        # Cloud-init configuration (optional)
```

#### 4. Edit Configuration (IMPORTANT!)

Before copying, edit `firstrun.sh` to set your network:

```bash
# Set your API URL (IP of your computer running NearHome API)
API_BASE_URL=http://192.168.1.X:3001

# Set WiFi credentials (optional, leave empty for ethernet)
WIFI_SSID=YourNetworkName
WIFI_PASSWORD=YourPassword
```

**To edit on Mac:**

```bash
# Mount the boot partition
open /Volumes/boot

# Edit with TextEdit or VS Code
```

**To edit on Windows:**

```bash
# The boot partition should be visible as a drive
# Open with Notepad
```

#### 5. Eject and Insert

1. Safely eject the SD card
2. Insert in Raspberry Pi 3B+
3. Connect Ethernet cable
4. Power on

#### 6. First Boot

On first boot, the script will:

- Update system
- Install Docker
- Install network tools
- Start the Edge Gateway container

This takes ~5-10 minutes. Check your router for the Pi's IP address.

#### 7. Verify

SSH into the Pi:

```bash
ssh pi@<PI_IP_ADDRESS>
# password: raspberry

# Check Docker is running
docker ps

# Check container logs
docker logs nearhome-edge-gateway
```

---

## File Contents

### config.txt

- Enables UART for debugging
- Sets device tree settings

### firstrun.sh

- Runs automatically on first boot
- Installs all dependencies
- Starts the edge gateway

### user-data.txt (optional)

- Cloud-init configuration
- Alternative to firstrun.sh
