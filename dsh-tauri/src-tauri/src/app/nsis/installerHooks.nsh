; DSH Desktop（Tauri 版）NSIS 安装钩子
; ==========================================================================
; v0.5.0 发布教训：多轮迭代 PREINSTALL 钩子（进程检测 + 注册表扫描 +
; 旧版卸载 + 目录采纳）始终在部分用户机上卡死（NSIS 栈序/strip 引号/
; 模式变量/ExecWait UAC/C# 卸载器自提权——五轮修五轮还有新根因）。
;
; 终极方案：PREINSTALL 钩子置空。Tauri NSIS 模板已自带：
;   · 进程检测（CheckIfAppIsRunning）——检测当前 productName 进程
;   · 安装位置复用（RestorePreviousInstallLocation）——读自身旧键
;   · 文件覆盖安装——旧版目录直接覆盖，数据目录（~/.dsh 与
;     %APPDATA%\dsh-desktop）天然不受影响
;
; v0.5.1 追加（本文件 DSH_DETECT_LEGACY_INSTALLDIR 宏）：
;   Tauri 模板的 RestorePreviousInstallLocation 只认 Tauri 自己写的
;   HKCU\Software\<manufacturer>\<productName> 键。Electron 线（0.3.x/
;   0.4.x，electron-builder NSIS）写的是完全不同的键，于是 0.4.x → 0.5.0
;   升级时目录页默认到 %LOCALAPPDATA%\DSH Desktop，老用户装出双目录。
;   修复：经 vendor 模板 installer-template.nsi 的挂载点，在该函数尾部
;   调用本文件的 DSH_DETECT_LEGACY_INSTALLDIR 宏——Tauri 自身键为空时，
;   只读探测 Electron 线注册表，预填 $INSTDIR 为旧安装目录。
;
; 【铁律】本宏运行在 .onInit（UI 线程），只允许：
;   ReadRegStr / StrCpy / ${If} / ${FileExists} / DetailPrint
; 禁止出现（历史上任一即卡死安装器）：
;   MessageBox / Exec / ExecWait / ExecShell / nsExec / nsDialogs /
;   Push / Pop / Exch（栈操作）/ FindWindow / SendMessage / kill /
;   Sleep / CopyFiles / Delete / RMDir / RenName / 任何写注册表
;
; 需要清理旧版注册表键的场景（Electron→Tauri 升级）由应用首次启动时
; 的 sidecar boot 链处理（sync/companion-profile 自愈），不再由
; 安装器承担。这消除了 ALL 可能的安装器卡死点。
;
; v0.6.5 加固（DSH_KILL_TREE_NODES / DSH_WAIT_FOR_INSTDIR_RELEASE）：
;   用户实报：覆盖安装中断在
;     Error opening file for writing:
;     <安装目录>\dsh-desktop\node_modules\@img\sharp-win32-x64\lib\libvips-42.dll
;   根因既不是权限也不是杀软 —— 点「×」关窗只是隐藏到托盘（windows.rs 的
;   closeToTray 缺省 true），内核的 vendor\node\node.exe 因此还活着、把 sharp 的
;   原生库映射在内存里；Windows 不允许覆盖「已被加载的映像」，所以只有 DLL/EXE
;   这类文件报错（成千上万个 .js 都能正常覆盖）。模板的 CheckIfAppIsRunning 只认
;   主程序名，而且**杀完不等待**句柄释放。
;
;   下面两个宏由 installer-template.nsi 在 CheckIfAppIsRunning 之后插入：
;     · DSH_KILL_TREE_NODES：按 ExecutablePath 前缀精确清掉本安装树的 node 进程
;       （不误伤系统里其它 node），经临时 ps1 执行以避开引号嵌套；
;     · DSH_WAIT_FOR_INSTDIR_RELEASE：有界轮询（≤15s）主程序与那个原生库是否真的
;       可写，期间补一次清理；仍被占用就明确告知「请从托盘退出应用或重启后再装」，
;       而不是让用户对着一个没有上下文的错误框反复点重试。
;
;   【与 .onInit 铁律的区别】这两个宏运行在安装段（Section Install），不是
;   .onInit/UI 线程，所以允许 Sleep / ExecWait / FileOpen。仍然禁止：UAC 自提权
;   子进程、Push/Pop/Exch 栈操作、以及任何无界等待 —— 历史上这几类都卡死过安装器。

Var DshLegacyDir
Var DshLegacyTmp

; Electron 线（electron-builder，appId=com.deepseek.dsh.desktop）的注册表事实：
;   · 卸载键名 = UUID.v5(appId) = 62276e9d-c5f3-5091-b4ee-c7144d6db450
;     （出处为 dsh-desktop/uninstaller/DSH_Desktop_Uninstaller.cs 里的
;       LegacyUninstallRegKey；该目录已随 Electron 线下线由 02981194 从工作树
;       移除，需核对原文时执行
;       `git show 02981194^:dsh-desktop/uninstaller/DSH_Desktop_Uninstaller.cs`。
;       本机 Log.log 卸载记录亦实证该键曾存在于 HKCU）
;   · 安装键 = Software\DSH Desktop（INSTALL_REGISTRY_KEY，
;     APP_FILENAME = productName「DSH Desktop」，oneClick:false → 保留空格）
;   · 两处都写 InstallLocation；per-user 构建落 HKCU，防御性补读 HKLM/WOW6432Node
;   · 旧目录可识别标记（五选一）：DSH Desktop.exe（0.4.x 主程序）、
;     dsh-desktop.exe（0.3.x 老线主程序名，2026-08-22 NS1 实测补齐）、
;     resources\node\node.exe（内置 Node 运行时）、
;     Uninstall_DSH_Desktop.exe（自研卸载器）、
;     Uninstall DSH Desktop.exe（electron-builder 官方卸载器，空格版兜底）
;
; 【/SD 与超时语义】本宏不含任何 MessageBox / 用户交互 —— /SD 防呆的
; 本质是「静默模式下 MessageBox 不许弹」，无 MessageBox 即零需求。
; 超时语义：每步都是单次同步内核调用（ReadRegStr 本地 hive / FileExists
; 一次 CreateFile），亚毫秒级完成，无轮询、无 Sleep、无等待句柄——
; 不存在「超时」概念，也就不存在悬挂面（v0.5.0 卡死的全部根因
; ——ExecWait UAC / C# 卸载器自提权 / 栈操作 / 枚举中删键——一概不在）。
!macro DSH_DETECT_LEGACY_INSTALLDIR
  ; 仅当 Tauri 自身键为空（$4 是调用方 RestorePreviousInstallLocation 刚读的
  ; MANUPRODUCTKEY 值）时探测——0.5.0+ 之间的升级仍走原生逻辑。
  ${If} $4 == ""
    StrCpy $DshLegacyDir ""

    ; 1) electron-builder 卸载键（InstallLocation 未被旧版卸载器清掉时的主来源）
    ReadRegStr $DshLegacyDir HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\62276e9d-c5f3-5091-b4ee-c7144d6db450" "InstallLocation"
    ${If} $DshLegacyDir == ""
      ReadRegStr $DshLegacyDir HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\62276e9d-c5f3-5091-b4ee-c7144d6db450" "InstallLocation"
    ${EndIf}
    ${If} $DshLegacyDir == ""
      ReadRegStr $DshLegacyDir HKLM "Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\62276e9d-c5f3-5091-b4ee-c7144d6db450" "InstallLocation"
    ${EndIf}

    ; 2) electron-builder 安装键（卸载键被清但软件还在的兜底）
    ${If} $DshLegacyDir == ""
      ReadRegStr $DshLegacyDir HKCU "Software\DSH Desktop" "InstallLocation"
    ${EndIf}
    ${If} $DshLegacyDir == ""
      ReadRegStr $DshLegacyDir HKLM "Software\WOW6432Node\DSH Desktop" "InstallLocation"
    ${EndIf}

    ; 归一化：去成对引号（部分写入方带引号），去尾部反斜杠
    StrCpy $DshLegacyTmp $DshLegacyDir 1
    ${If} $DshLegacyTmp == '"'
      StrCpy $DshLegacyDir $DshLegacyDir "" 1
      StrCpy $DshLegacyDir $DshLegacyDir -1
    ${EndIf}
    StrCpy $DshLegacyTmp $DshLegacyDir "" 1
    ${If} $DshLegacyTmp == "\"
      StrCpy $DshLegacyDir $DshLegacyDir -1
    ${EndIf}

    ; 3) 校验：目录存在且含 Electron 线标记才采纳，防止指向已改名/残留空壳目录
    ;    标记集（2026-08-22 补齐，NS1 实测发现 0.3.x 老线漏网）：
    ;      DSH Desktop.exe            —— 0.4.x 主程序（productName，本机 dist 实证）
    ;      dsh-desktop.exe            —— 0.3.x 老线主程序（package.json name 命名，
    ;                                   23802d38 漏收致老线用户仍装双目录，本次补）
    ;      resources\node\node.exe    —— 内置 Node 运行时（跨版本）
    ;      Uninstall_DSH_Desktop.exe  —— 自研卸载器（下划线版）
    ;      Uninstall DSH Desktop.exe  —— electron-builder 官方卸载器（空格版，兜底）
    ${If} $DshLegacyDir != ""
      ${If} ${FileExists} "$DshLegacyDir\DSH Desktop.exe"
      ${OrIf} ${FileExists} "$DshLegacyDir\dsh-desktop.exe"
      ${OrIf} ${FileExists} "$DshLegacyDir\resources\node\node.exe"
      ${OrIf} ${FileExists} "$DshLegacyDir\Uninstall_DSH_Desktop.exe"
      ${OrIf} ${FileExists} "$DshLegacyDir\Uninstall DSH Desktop.exe"
        StrCpy $INSTDIR $DshLegacyDir
        DetailPrint "DSH: legacy Electron install dir adopted: $INSTDIR"
      ${Else}
        DetailPrint "DSH: legacy install dir found but no marker, ignored: $DshLegacyDir"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; v0.5.1：PREINSTALL 本体保持为空（五轮修复后仍有用户卡死的教训——安装器的
  ; 唯一职责是装文件，清理逻辑交给应用运行时）。
  ; 旧版目录识别在 .onInit 阶段由 DSH_DETECT_LEGACY_INSTALLDIR 完成。
  ; v0.6.5：覆盖安装前的进程/句柄清理**不放在这里**，而是紧跟在本宏之后、
  ; CheckIfAppIsRunning 之后（见下面两个宏）——必须等主程序被杀掉、Job Object
  ; 收走内核树之后再去等句柄，否则等的还是自己刚杀掉的那批进程。
  DetailPrint "PREINSTALL: skip (Tauri template handles process check & location)"
!macroend

; 精确清掉「本安装树内」的内核 node 子进程。
; 用 ExecutablePath/CommandLine 前缀匹配而不是 taskkill /IM node.exe —— 后者会误杀
; 用户自己的 node 服务。经临时 ps1 执行是为了零引号嵌套（历史教训：strip 引号把
; 安装器卡死）。
;
; 【实测坑，别再改回去】不要用 `Get-Process node | Where-Object { $_.Path -like … }`：
; 在安装器的子 PowerShell 里 `$_.Path` **对所有进程都是空的**（连系统 node 也是），
; 过滤永远匹配不到——宏会「静默空转」，覆盖安装照样弹 Error opening file for writing。
; `Get-CimInstance Win32_Process` 的 ExecutablePath / CommandLine 在该上下文里有值。
; 另外 CommandLine 还兜住「node.exe 在系统目录、但脚本路径落在安装树里」的形态。
; 寄存器：$0（ps1 句柄）。调用方不得依赖 $0。
!macro DSH_KILL_TREE_NODES
  ClearErrors
  FileOpen $0 "$TEMP\dsh-kill-nodes.ps1" w
  FileWrite $0 "Get-CimInstance Win32_Process | Where-Object { $$_.Name -eq 'node.exe' -and ($$_.ExecutablePath -like ('$INSTDIR*') -or $$_.CommandLine -like ('*$INSTDIR*')) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }$\r$\n"
  FileClose $0
  ExecWait 'powershell -NoProfile -ExecutionPolicy Bypass -File "$TEMP\dsh-kill-nodes.ps1"'
  Delete "$TEMP\dsh-kill-nodes.ps1"
!macroend

; 等目标文件「真的可写」再继续复制（有界：最多 30 × 500ms = 15s）。
; 探针挑两类在真机上会被占用的文件：主程序 exe 与实测报错的 sharp 原生库
; （其余 .js/.json 即使被打开也能覆盖，探它们没意义）。文件不存在则跳过探测
; —— 全新安装没有旧句柄可等。
; 全程只读探测 + 有界睡眠；超时后**只提示不阻断**（静默安装不弹框），把判断留给
; 用户与 NSIS 自带的「重试/忽略」对话框。
; 寄存器：$0（kill 宏用）、$1（轮次）、$2（文件句柄）。
!macro DSH_WAIT_FOR_INSTDIR_RELEASE
  StrCpy $1 0
  dsh_rel_wait:
    ; 首轮清理可能恰逢进程退出中：等 3s 后再补一次。
    ${If} $1 == 6
      !insertmacro DSH_KILL_TREE_NODES
    ${EndIf}
    ClearErrors
    IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 dsh_rel_probe_lib
    FileOpen $2 "$INSTDIR\${MAINBINARYNAME}.exe" a
    ${If} ${Errors}
      Goto dsh_rel_busy
    ${EndIf}
    FileClose $2
  dsh_rel_probe_lib:
    ClearErrors
    IfFileExists "$INSTDIR\dsh-desktop\node_modules\@img\sharp-win32-x64\lib\libvips-42.dll" 0 dsh_rel_ok
    FileOpen $2 "$INSTDIR\dsh-desktop\node_modules\@img\sharp-win32-x64\lib\libvips-42.dll" a
    ${If} ${Errors}
      Goto dsh_rel_busy
    ${EndIf}
    FileClose $2
  dsh_rel_ok:
    ${If} $1 > 0
      DetailPrint "PREINSTALL: 目标文件已释放（等待 $1 轮 / 每轮 500ms）"
    ${EndIf}
    Goto dsh_rel_done
  dsh_rel_busy:
    IntOp $1 $1 + 1
    ${If} $1 > 30
      DetailPrint "WARN: 目标目录仍有被占用的文件（多为上一次的应用或其内核还在运行）"
      ${IfNot} ${Silent}
        MessageBox MB_ICONEXCLAMATION|MB_OK "检测到 $INSTDIR 里仍有程序在运行并占用文件。$\r$\n$\r$\n请从系统托盘图标退出 DSH Desktop（关窗口只是隐藏到托盘），或重启电脑后再安装。$\r$\n$\r$\n继续安装可能会在复制某个 DLL 时报错。"
      ${EndIf}
      Goto dsh_rel_done
    ${EndIf}
    Sleep 500
    Goto dsh_rel_wait
  dsh_rel_done:
!macroend
