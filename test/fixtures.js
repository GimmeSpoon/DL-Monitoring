// Captured raw outputs of the combined monitoring command (lib/collector.js).
// Kept as JS strings because *.txt is gitignored.

// Real output captured on a 4x H200 box (2026-07-21). Note the bracketed
// nvidia-smi placeholders and the empty APPS/PS sections.
const REAL_H200 = `0, 2026/07/21 07:34:18.342, NVIDIA H200, 580.159.03, [Requested functionality has been deprecated], Disabled, [N/A], 45, 47, 384.07, 700.00, 133791, 143771, 100, 55, P0
1, 2026/07/21 07:34:18.350, NVIDIA H200, 580.159.03, [Requested functionality has been deprecated], Disabled, [N/A], 65, 50, 683.64, 700.00, 84335, 143771, 100, 2, P0
2, 2026/07/21 07:34:18.354, NVIDIA H200, 580.159.03, [Requested functionality has been deprecated], Disabled, [N/A], 72, 57, 689.03, 700.00, 104261, 143771, 100, 1, P0
3, 2026/07/21 07:34:18.359, NVIDIA H200, 580.159.03, [Requested functionality has been deprecated], Disabled, [N/A], 46, 47, 122.94, 700.00, 131567, 143771, 0, 0, P0
@@APPS
@@UUID
0, GPU-8b06f67c-36d9-cc08-2bf0-91112a3cc446
1, GPU-46570e99-c968-c8a1-d119-bfa45e0d70b5
2, GPU-2d9c7f53-0f17-ca25-9955-634582e4e937
3, GPU-a7a9d519-d7b3-f8e7-4e3f-37bdab43ac1d
@@PS
@@CPU
cpu  323873481 43894292 176683276 22721476676 2704416 0 1864740 0 0 0
224
10.62 10.02 9.72 10/57311 1891587
@@MEM
2164193714176 186191519744 1966154215424
@@DISK
/dev/md0       /usr/bin/nvidia-smi  1888425144320  1400301363200
/dev/md127     /mnt/cwna           30601613336576 22892221218816
@@NVCC
Cuda compilation tools, release 12.6, V12.6.68`;

// Synthetic output with running compute apps and users, and a duplicated
// disk source (bind mount) that must be deduplicated.
const SYNTHETIC = `0, 2026/07/21 12:00:00.000, NVIDIA GeForce RTX 3090, 525.105.17, Enabled, Disabled, 55, 61, 70, 250.10, 350.00, 12000, 24576, 87, 40, P2
1, 2026/07/21 12:00:00.010, NVIDIA GeForce RTX 3090, 525.105.17, Enabled, Disabled, 30, 41, 50, 30.55, 350.00, 8192, 24576, 0, 0, P8
@@APPS
GPU-aaaa, 1234, 2048
GPU-aaaa, 1235, 4096
GPU-bbbb, 2345, 8192
@@UUID
0, GPU-aaaa
1, GPU-bbbb
@@PS
   1234 alice
   1235 alice
   2345 bob
@@CPU
cpu  100 0 100 700 100 0 0 0 0 0
32
1.50 1.20 1.00 2/800 4242
@@MEM
137438953472 34359738368 96636764160
@@DISK
/dev/sda1      /                1888425144320  1400301363200
/dev/sda1      /usr/bin/podman  1888425144320  1400301363200
/dev/sdb1      /data           30601613336576 22892221218816
@@NVCC
Cuda compilation tools, release 11.8, V11.8.89`;

module.exports = { REAL_H200, SYNTHETIC };
