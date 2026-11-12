// ImOverlay.Build.cs — UE 5 插件模块规则
// 链接预编译的 IMOverlay.dll / .lib，暴露给游戏 C++ 和 Blueprint 层。

using System.IO;
using UnrealBuildTool;

public class ImOverlay : ModuleRules
{
    public ImOverlay(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = ModuleRules.PCHUsageMode.UseExplicitOrSharedPCHs;

        PublicIncludePaths.AddRange(new[]
        {
            Path.Combine(ModuleDirectory, "..", "..", "Include")
        });

        // UE 引擎依赖
        PublicDependencyModuleNames.AddRange(new[]
        {
            "Core",
            "CoreUObject",
            "Engine",
            "GameplayTasks",
            "UMG",
            "RenderCore",
            "RHI"
        });

        PrivateDependencyModuleNames.AddRange(new[]
        {
            "Slate",
            "SlateCore"
        });

        // —— 预编译 IMOverlay.dll / .lib 路径 ——
        string LibDir = Path.Combine(ModuleDirectory, "..", "..", "Lib");
        string BinDir = Path.Combine(ModuleDirectory, "..", "..", "Binaries");

        if (Target.Platform == UnrealTargetPlatform.Win64)
        {
            string Win64Lib = Path.Combine(LibDir, "Win64", "IMOverlay.lib");
            string Win64Bin = Path.Combine(BinDir, "Win64", "IMOverlay.dll");

            if (File.Exists(Win64Lib))
            {
                PublicAdditionalLibraries.Add(Win64Lib);
            }
            else
            {
                System.Console.WriteLine("[ImOverlay] WARNING: IMOverlay.lib not found at " + Win64Lib);
            }
            if (File.Exists(Win64Bin))
            {
                RuntimeDependencies.Add(Win64Bin);
                PublicDelayLoadDLLs.Add("IMOverlay.dll");
            }
        }
        else if (Target.Platform == UnrealTargetPlatform.Win32)
        {
            string Win32Lib = Path.Combine(LibDir, "Win32", "IMOverlay.lib");
            string Win32Bin = Path.Combine(BinDir, "Win32", "IMOverlay.dll");

            if (File.Exists(Win32Lib))
            {
                PublicAdditionalLibraries.Add(Win32Lib);
            }
            if (File.Exists(Win32Bin))
            {
                RuntimeDependencies.Add(Win32Bin);
                PublicDelayLoadDLLs.Add("IMOverlay.dll");
            }
        }

        // —— Windows SDK 系统库 ——
        PublicSystemLibraries.AddRange(new[]
        {
            "user32.lib",
            "kernel32.lib",
            "d3d11.lib",
            "d3d12.lib",
            "dxgi.lib",
            "opengl32.lib",
            "vulkan-1.lib"
        });
    }
}
