# Silo Desktop

Silo is a high-performance local network file sharing and remote control utility. It operates entirely over UDP on your local network, bypassing cloud servers to deliver Gigabit transfer speeds, minimal latency, and strict data privacy.

## Features

- High-Speed Local File Transfer: Send large directories and media files directly over the local network using a custom low-overhead UDP protocol.
- Remote Control and Precision Input: Map your Android device's touchscreen to your PC for trackpad control, left/right clicks, and keyboard input.
- Low-Latency Viewfinder: Stream your Android device's camera feed directly to your desktop.
- Private and Secure: Operates entirely offline with zero external servers, requiring no logins or tracking.

## Installation

### Method 1: Installer Package (Recommended)

1. Navigate to the official website: [Download Silo](https://candyragi.github.io/silo-website)
2. Download the latest `Silo-Windows-Setup.zip` release.
3. Extract the downloaded ZIP archive.
4. Double-click the `install.cmd` script. This script automatically handles execution policies and installs the application to your local application data directory.
5. Once the installation completes, launch Silo from the newly created Desktop or Start Menu shortcuts.

### Method 2: Manual Build from Source

For developers who wish to build the application locally:

1. Clone this repository to your local machine.
2. Ensure Node.js is installed.
3. Open a terminal in the project directory and run `npm install` to download dependencies.
4. Run `npm start` to launch the application in development mode.
5. To package the application into a standalone installer, execute the `build-dist.ps1` script via PowerShell.

## Setup Instructions

1. Ensure Silo Desktop is running on your Windows machine and allowed through your Windows Firewall if prompted.
2. Install the Silo companion app on your Android device.
3. Connect both devices to the same local area network.
4. Open the Silo Android application, tap to scan for available devices, and select your desktop to establish a connection.
5. Accept the pairing request on the desktop application to finalize the connection.

## System Requirements

- Operating System: Windows 10 or later
- Network: Local Area Network connection (Wi-Fi or Ethernet)

## License

This project is licensed under the MIT License.
