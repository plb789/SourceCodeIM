; 脚本由 Inno Setup 脚本向导 生成！
; 有关创建 Inno Setup 脚本文件的详细资料请查阅帮助文档！

[Setup]
; 注意: AppId 值用于唯一识别该应用程序。
; 禁止对其他应用程序的安装器使用相同的 AppId 值！
; (若要生成一个新的 GUID，请选择“工具 | 生成 GUID”。)
AppId={{2D6DE451-E478-4DA5-BA21-862D06F77EE1}}
AppName=狮王对战平台
AppVersion=1.0
AppVerName=狮王对战平台 1.0.0.0
AppPublisher=游戏乐悠悠
AppPublisherURL=http://bbs.yxlyy.club/
AppSupportURL=http://bbs.yxlyy.club/
AppUpdatesURL=http://bbs.yxlyy.club/
DefaultDirName=D:\BattlePlatform
; DisableDirPage=yes
DefaultGroupName=狮王对战平台
DisableProgramGroupPage=yes
LicenseFile=D:\Program Files\Inno Setup 5\BattlePlatform\许可文件CSLauncher.txt
InfoBeforeFile=D:\Program Files\Inno Setup 5\BattlePlatform\安装之前CSLauncher.txt
InfoAfterFile=D:\Program Files\Inno Setup 5\BattlePlatform\安装之后CSLauncher.txt
OutputDir=D:\安装文件输出\狮王对战平台
;OutputBaseFilename=QNGameSetup
OutputBaseFilename=狮王对战平台
SetupIconFile=D:\Program Files\Inno Setup 5\BattlePlatform\iconCSLauncher.ico
Compression=lzma
SolidCompression=yes
DiskSpanning=false
DiskSliceSize=2100000000

[Languages]
Name: "chinese"; MessagesFile: "compiler:Default.isl"

; 创建快捷图标
[Tasks]
; 默认选中
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: checkablealone
Name: "quicklaunchicon"; Description: "{cm:CreateQuickLaunchIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: checkablealone

[Files]
; ---------- 根目录文件（仅 bin 下第一层文件，不递归子目录） ----------
Source: "E:\SourceCodeIM\im-client\bin\elevator.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "E:\SourceCodeIM\im-client\bin\im-client.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "E:\SourceCodeIM\im-client\bin\chrome_100_percent.pak"; DestDir: "{app}"; Flags: ignoreversion
Source: "E:\SourceCodeIM\im-client\bin\chrome_200_percent.pak"; DestDir: "{app}"; Flags: ignoreversion
Source: "E:\SourceCodeIM\im-client\bin\d3dcompiler_47.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "E:\SourceCodeIM\im-client\bin\dxcompiler.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "E:\SourceCodeIM\im-client\bin\dxil.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "E:\SourceCodeIM\im-client\bin\ffmpeg.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "E:\SourceCodeIM\im-client\bin\icudtl.dat"; DestDir: "{app}"; Flags: ignoreversion
Source: "E:\SourceCodeIM\im-client\bin\LICENSE.electron.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "E:\SourceCodeIM\im-client\bin\LICENSES.chromium.html"; DestDir: "{app}"; Flags: ignoreversion
Source: "E:\SourceCodeIM\im-client\bin\resources.pak"; DestDir: "{app}"; Flags: ignoreversion
Source: "E:\SourceCodeIM\im-client\bin\snapshot_blob.bin"; DestDir: "{app}"; Flags: ignoreversion
Source: "E:\SourceCodeIM\im-client\bin\v8_context_snapshot.bin"; DestDir: "{app}"; Flags: ignoreversion
Source: "E:\SourceCodeIM\im-client\bin\vk_swiftshader.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "E:\SourceCodeIM\im-client\bin\vk_swiftshader_icd.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "E:\SourceCodeIM\im-client\bin\vulkan-1.dll"; DestDir: "{app}"; Flags: ignoreversion

; ---------- locales 目录（含全部子目录，递归复制） ----------
Source: "E:\SourceCodeIM\im-client\bin\locales\*"; DestDir: "{app}\locales"; Flags: ignoreversion recursesubdirs createallsubdirs

; ---------- resources 目录（递归复制完整目录树，包括以下所有内容） ----------
; resources\app.asar / app-update.yml / gcc-toolchain.zip / node-runtime.zip / rclone.exe
; resources\app.asar.unpacked\（node_modules 深层子目录全部包含）
; resources\dlbt-host\  resources\Driver\  resources\overlay-native\（含 bin 子目录）
; resources\Steam\SmartSteamEmu\（含 Common / Plugins\SSEOverlay / x64 / x86 子目录）
Source: "E:\SourceCodeIM\im-client\bin\resources\*"; DestDir: "{app}\resources"; Flags: ignoreversion recursesubdirs createallsubdirs

; 注意: 不要在任何共享系统文件上使用“Flags: ignoreversion”
[dirs]
; 客户端不依赖安装目录下的预建子目录（游戏安装目录由用户在客户端内自行选择）
[Registry]
Root: HKCR; Subkey: "BattlePlatform"; ValueType: String; ValueData: "狮王对战平台";Flags: uninsdeletekey
Root: HKCR; Subkey: "BattlePlatform"; ValueType: String; ValueName: "URL Protocol";ValueData: "狮王对战平台";Flags: uninsdeletekey
Root: HKCR; Subkey: "BattlePlatform\DefaultIcon"; ValueType: String; ValueData: """{app}\elevator.exe,0""";Flags: uninsdeletekey
Root: HKCR; Subkey: "BattlePlatform\DefaultIcon"; ValueType: String; ValueName: "Route";ValueData: "{app}";Flags: uninsdeletekey
Root: HKCR; Subkey: "BattlePlatform\shell\open\command"; ValueType: String; ValueData: """{app}\elevator.exe"" ""%1""";Flags: uninsdeletekey

[Icons]
Name: "{group}\狮王对战平台"; Filename: "{app}\elevator.exe"
Name: "{group}\{cm:UninstallProgram,狮王对战平台}"; Filename: "{uninstallexe}"
Name: "{commondesktop}\狮王对战平台"; Filename: "{app}\elevator.exe"; Tasks: desktopicon
Name: "{userappdata}\Microsoft\Internet Explorer\Quick Launch\狮王对战平台"; Filename: "{app}\elevator.exe"; Tasks: quicklaunchicon

;卸载前删除安装目录
[UninstallDelete]
; 客户端运行时数据（日志/缓存/聊天记录）位于 %LOCALAPPDATA%\im-client（Electron userData）
; 与 deleteAppDataOnUninstall:false 行为一致，卸载时不自动删除，保护用户聊天数据
[InstallDelete]
;Type: filesandordirs; Name: “{app}\temp”
;Type: filesandordirs; Name: “{app}\unins000.dat”
;Type: filesandordirs; Name: “{app}\unins000.exe”
;Type: filesandordirs; Name: "{userdocs}\gyxny2024"

[Run]
; Electron 客户端自带运行时，无需安装 .NET（原 CSLauncher 平台遗留条目已删除）
; 安装完成后清理可能残留的 TAP 虚拟网卡驱动（驱动文件随包位于 resources\Driver）
Filename: "{app}\resources\Driver\tapinstall.exe"; Parameters: "remove tap0901"; WorkingDir: {app}; StatusMsg: "清理残留 TAP 驱动"; Flags: runhidden
[UninstallRun]
; 新增：卸载时运行tapinstall.exe移除驱动
Filename: "{app}\resources\Driver\tapinstall.exe"; Parameters: "remove tap0901"; Flags: runhidden

[Code]
function IsValidPath(Path: string): Boolean;
var
  i: Integer;
  Ch: Char;
begin
  Result := True;

  // 检查路径中是否包含中文字符
  for i := 1 to Length(Path) do
  begin
    Ch := Path[i];
    if (Ord(Ch) >= $4E00) and (Ord(Ch) <= $9FFF) then
    begin
      Result := False;
      Break;
    end;
  end;

  if not Result then
    MsgBox('安装路径不能包含中文字符，请使用英文路径！'#13#10'例如：D:\BattlePlatform', mbError, MB_OK);
end;

// 初始化安装程序
function InitializeSetup(): Boolean;
begin
  Result := True;
end;

// 向导窗口创建后初始化
procedure InitializeWizard();
begin
  // 默认选中同意协议
  WizardForm.LICENSEACCEPTEDRADIO.Checked := True;
end;

// 点击"下一步"时强制检测路径（唯一检测点）
function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;

  // 仅在目录选择页面（ID=2）检测
  if CurPageID = 2 then
  begin
    // 路径无效则阻止继续，反复提示直到修改正确
    Result := IsValidPath(WizardForm.DirEdit.Text);
  end;
end;

