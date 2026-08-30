; Build with Inno Setup 6. Per-user install, never changes Grok Bot itself.
#ifndef BuildRoot
  #define BuildRoot "..\runtime\desktop-build"
#endif
[Setup]
AppId=GrokBotSwitch
AppName=Grok Bot Switch
AppVersion=0.2.0
AppPublisher=Grok Bot Switch contributors
DefaultDirName={localappdata}\Programs\GrokBotSwitch
DefaultGroupName=Grok Bot Switch
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#BuildRoot}
OutputBaseFilename=GrokBotSwitch-0.2.0-windows-x64-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\GrokBotSwitch.exe
[Files]
Source: "{#BuildRoot}\dist\GrokBotSwitch\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
[Icons]
Name: "{group}\Grok Bot Switch"; Filename: "{app}\GrokBotSwitch.exe"
Name: "{autodesktop}\Grok Bot Switch"; Filename: "{app}\GrokBotSwitch.exe"; Tasks: desktopicon
[Tasks]
Name: desktopicon; Description: "Create a desktop shortcut"; Flags: unchecked
[Run]
Filename: "{app}\GrokBotSwitch.exe"; Description: "Open Grok Bot Switch"; Flags: nowait postinstall skipifsilent
; No UninstallDelete for app data: saved profiles and secrets survive uninstall.
