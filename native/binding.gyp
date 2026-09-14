{
  "targets": [
    {
      "target_name": "domino_vcam",
      # Sources are chosen per platform below. The two implementations share
      # nothing but the N-API surface they present: Windows needs a media source
      # in another process fed over shared memory, while Linux writes frames
      # straight into a v4l2loopback node.
      "sources": [],
      "include_dirs": [
        # Forward slashes deliberately: gyp strips backslashes out of this
        # substitution, which silently produced "..\..node_modulesnode-addon-api"
        # and a missing napi.h.
        "<!@(node -p \"require('node-addon-api').include_dir.split(require('path').sep).join('/')\")"
      ],
      # N-API only: no direct V8 use, so one build works across Node and
      # Electron versions without rebuilding per ABI.
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS"
      ],
      "conditions": [
        [
          "OS=='win'",
          {
            "sources": [
              "addon/addon.cpp",
              "addon/CaptureProbe.cpp",
              "addon/FrameChannel.cpp",
              "addon/VirtualCamera.cpp"
            ],
            "include_dirs": [
              "shared"
            ],
            "defines": [
              "NOMINMAX",
              "WIN32_LEAN_AND_MEAN",
              "UNICODE",
              "_UNICODE"
            ],
            "libraries": [
              "-lmfsensorgroup.lib",
              "-lmf.lib",
              "-lmfplat.lib",
              "-lmfreadwrite.lib",
              "-lmfuuid.lib",
              "-lole32.lib",
              "-loleaut32.lib",
              "-ladvapi32.lib",
              "-lshell32.lib",
              "-lstrmiids.lib"
            ],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1,
                # Link-time code generation leaves a stale IPDB behind whenever
                # only part of the target is recompiled, and the next link dies
                # with "debugging information corrupt". Nothing here is hot
                # enough to be worth that.
                "WholeProgramOptimization": "false",
                "AdditionalOptions": ["/std:c++17"]
              },
              "VCLinkerTool": {
                "LinkTimeCodeGeneration": 0
              }
            }
          }
        ],
        [
          "OS=='linux'",
          {
            "sources": [
              "linux/addon.cpp",
              "linux/CaptureProbe.cpp",
              "linux/V4l2Output.cpp"
            ],
            # Only libc and the kernel's uapi headers, both of which are
            # already required to build any Node addon. Nothing here links
            # against libv4l, GTK or a portal library, so the addon builds on a
            # bare container and the .node file has no distro-specific
            # dependencies to go stale.
            "libraries": [],
            # node-gyp compiles addons with -fno-exceptions by default. The
            # Windows half is built with exceptions on, and the shared code
            # below uses the standard library freely, so match it rather than
            # keeping two dialects of C++ in one addon.
            "cflags_cc!": ["-fno-exceptions"],
            "cflags_cc": ["-std=c++17", "-fexceptions"]
          }
        ]
      ]
    },
    {
      # The media source COM server. This is a plain DLL, not a .node addon:
      # the Windows Frame Server loads it into its own process, where nothing
      # about Node or Electron exists. It shares only the protocol and reader
      # headers with the addon above.
      #
      # There is no Linux counterpart and there does not need to be - the
      # kernel's v4l2loopback module already plays this part - so off Windows
      # the target builds nothing rather than being dropped, which would make
      # `node-gyp build` fail on a name it was told to build.
      "target_name": "domino_vcam_source",
      "type": "none",
      "sources": [],
      "conditions": [
        [
          "OS=='win'",
          {
            "type": "shared_library",
            "product_extension": "dll",
            "variables": {
              # The delay-load hook exists to let a .node addon find node.exe
              # exports. Linking it into a DLL that Windows loads on its own
              # would make it fail to load at all.
              "win_delay_load_hook": "false"
            },
            "sources": [
              "vcam/dllmain.cpp",
              "vcam/MediaSource.cpp",
              "vcam/MediaSourceActivate.cpp",
              "vcam/MediaStream.cpp"
            ],
            "include_dirs": [
              "shared",
              "vcam"
            ],
            "defines": [
              "NOMINMAX",
              "WIN32_LEAN_AND_MEAN",
              "UNICODE",
              "_UNICODE"
            ],
            "libraries": [
              "-lmfplat.lib",
              "-lmfuuid.lib",
              "-lmf.lib",
              "-lole32.lib",
              "-loleaut32.lib",
              "-lksuser.lib",
              "-ladvapi32.lib"
            ],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1,
                "WholeProgramOptimization": "false",
                "AdditionalOptions": ["/std:c++17"]
              },
              "VCLinkerTool": {
                "LinkTimeCodeGeneration": 0,
                # Without this the DLL exports nothing and COM cannot create
                # the class, which surfaces only as a camera that will not
                # start.
                "ModuleDefinitionFile":
                    "<(module_root_dir)/vcam/domino_vcam_source.def"
              }
            }
          }
        ]
      ]
    }
  ]
}
