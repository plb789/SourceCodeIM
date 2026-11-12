# =====================================================================
#  IMOverlay.dll — CMake 构建脚本
#  依赖：
#    - Visual Studio 2019/2022 (MSVC) 或 MinGW-w64 / Clang-cl
#    - Windows SDK 10.0.19041.0+
#    - ImGUI 1.90+（本地 third_party/overlay-native/third_party/imgui/）
#  目标：Windows x64 + Win32（两个独立 build 目录）
#  链接方式：/MT 静态链接 CRT —— 商户不需要额外 VC 运行时
#  构建帧内渲染：D3D9 / D3D11 / D3D12 / Vulkan / OpenGL 3+ 五后端
# =====================================================================

cmake_minimum_required(VERSION 3.16)
project(IMOverlay VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 11)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# —— ImGUI 三方库路径（复用项目内已有的 overlay-native）——
# 这个路径相对项目根目录；构建 DLL 时用 SDK 目录的 ..
set(IMGUI_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../im-client/pc/overlay-native/third_party/imgui")

# —— MSVC 专用编译选项 ——
if(MSVC)
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
    add_compile_options(
        /W4 /permissive- /EHsc /utf-8 /MP /GS /sdl
        $<$<CONFIG:Release>:/GL>
    )
    add_compile_definitions(_CRT_SECURE_NO_WARNINGS IMOVERLAY_EXPORTS)
    # ImGui DX12 backend on 32-bit requires ImTextureID = ImU64 (64-bit value)
    if(CMAKE_SIZEOF_VOID_P EQUAL 4)
        add_compile_definitions(ImTextureID=ImU64)
        message(STATUS "  [32-bit] Adding /DImTextureID=ImU64 for DX12 backend")
    endif()
endif()

# —— MinGW / Clang-cl 兼容 ——
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    add_compile_options(-Wall -Wextra -Wpedantic -fvisibility=hidden)
    add_compile_definitions(IMOVERLAY_EXPORTS)
endif()

# —— ImGUI 源码（编进 DLL，静态链接）——
# 根据可用 SDK 动态选择后端
set(IMGUI_SOURCES
    "${IMGUI_ROOT}/imgui.cpp"
    "${IMGUI_ROOT}/imgui_draw.cpp"
    "${IMGUI_ROOT}/imgui_tables.cpp"
    "${IMGUI_ROOT}/imgui_widgets.cpp"
    "${IMGUI_ROOT}/backends/imgui_impl_win32.cpp"
    "${IMGUI_ROOT}/backends/imgui_impl_dx11.cpp"
    "${IMGUI_ROOT}/backends/imgui_impl_dx12.cpp"
    "${IMGUI_ROOT}/backends/imgui_impl_opengl3.cpp"
)

# —— Vulkan 后端（可选：需要 Vulkan SDK 或 Windows SDK 含 vulkan.h）——
find_path(VULKAN_INCLUDE_DIR vulkan/vulkan.h
    HINTS $ENV{VULKAN_SDK}
    PATH_SUFFIXES Include
)
if(VULKAN_INCLUDE_DIR)
    message(STATUS "  [✓] Vulkan SDK found at ${VULKAN_INCLUDE_DIR} — enabling imgui_impl_vulkan")
    list(APPEND IMGUI_SOURCES "${IMGUI_ROOT}/backends/imgui_impl_vulkan.cpp")
    add_compile_definitions(IMOVERLAY_HAS_VULKAN)
else()
    message(STATUS "  [✗] Vulkan SDK not found — skipping Vulkan backend (D3D11/D3D12/OpenGL3 still work)")
    add_compile_definitions(IMOVERLAY_NO_VULKAN)
endif()

# —— DLL 目标 ——
add_library(IMOverlay SHARED
    IMOverlay.cpp
    IMOverlay.h
    exports.def
    # Renderer + UI
    renderer/render_engine.h
    renderer/render_engine.cpp
    ui/ui_panels.h
    ui/ui_panels.cpp
    # ImGUI 三方库
    ${IMGUI_SOURCES}
)

# —— ImGUI include 目录 ——
target_include_directories(IMOverlay PRIVATE
    "${IMGUI_ROOT}"
    "${IMGUI_ROOT}/backends"
)

# —— 对外暴露 IMOverlay.h ——
target_include_directories(IMOverlay PUBLIC
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}>
)

# —— Windows SDK 链接库（D3D11/D3D12/OpenGL 始终链接，Vulkan 条件链接）——
target_link_libraries(IMOverlay PRIVATE
    kernel32 user32 gdi32 advapi32
    d3d11 d3d12 dxgi d3dcompiler
    opengl32 glu32
)
if(VULKAN_INCLUDE_DIR)
    target_link_libraries(IMOverlay PRIVATE vulkan-1)
endif()

# —— 显式导出符号（.def 文件，双保险防止 name mangling）——
if(MSVC)
    set_target_properties(IMOverlay PROPERTIES
        LINK_FLAGS "/DEF:${CMAKE_CURRENT_SOURCE_DIR}/exports.def"
    )
endif()

# —— 输出目录 ——
set_target_properties(IMOverlay PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin/${CMAKE_SYSTEM_PROCESSOR}/${CMAKE_BUILD_TYPE}
    LIBRARY_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin/${CMAKE_SYSTEM_PROCESSOR}/${CMAKE_BUILD_TYPE}
    ARCHIVE_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/lib/${CMAKE_SYSTEM_PROCESSOR}/${CMAKE_BUILD_TYPE}
    PDB_OUTPUT_DIRECTORY     ${CMAKE_BINARY_DIR}/pdb/${CMAKE_SYSTEM_PROCESSOR}/${CMAKE_BUILD_TYPE}
)

# —— ImGUI 编译选项（不需要异常，不需要 RTTI）——
if(MSVC)
    set_source_files_properties(${IMGUI_SOURCES} PROPERTIES COMPILE_FLAGS "/wd4245 /wd4996")
endif()

# —— Vulkan include（如果找到了，加上头文件路径）——
if(VULKAN_INCLUDE_DIR)
    target_include_directories(IMOverlay PRIVATE "${VULKAN_INCLUDE_DIR}")
endif()

# —— 安装目标 ——
install(TARGETS IMOverlay
    RUNTIME  DESTINATION bin
    LIBRARY  DESTINATION lib
    ARCHIVE  DESTINATION lib
)
install(FILES IMOverlay.h DESTINATION include)

# —— 构建提示 ——
message(STATUS "=== IMOverlay CMake Config (v${PROJECT_VERSION}) ===")
message(STATUS "  Platform  : ${CMAKE_SYSTEM_PROCESSOR}")
message(STATUS "  Generator : ${CMAKE_GENERATOR}")
message(STATUS "  Compiler  : ${CMAKE_CXX_COMPILER_ID} ${CMAKE_CXX_COMPILER_VERSION}")
message(STATUS "  CRT       : ${CMAKE_MSVC_RUNTIME_LIBRARY}")
message(STATUS "  ImGUI     : ${IMGUI_ROOT}")
message(STATUS "  Vulkan    : ${VULKAN_INCLUDE_DIR}")
message(STATUS "  Output    : ${CMAKE_BINARY_DIR}/bin/${CMAKE_SYSTEM_PROCESSOR}/${CMAKE_BUILD_TYPE}")
message(STATUS "  Backends  : DX9/DX11/DX12/Vulkan/OpenGL3 + FloatingWindow")
message(STATUS "===================================================")
