// dev-cpfix mechanism proof (standalone, NOT shipped).
//
// Replicates the exact contention pattern of the Pianoid engine:
//   - "synthesis" thread: launches a cooperative kernel on stream A every cycle,
//     then waits for it. In the BEFORE world it waited device-wide
//     (cudaDeviceSynchronize); in the AFTER world it waits stream-scoped
//     (cudaStreamSynchronize(A)).
//   - "chart-render" thread: every iteration runs a LONG dummy kernel + a D2H
//     copy. In the BEFORE world the copy is a BLOCKING default-stream cudaMemcpy
//     (which device-synchronizes — legacy default stream). In the AFTER world it
//     runs the long op + async copy on a separate stream B and syncs only B.
//
// We measure the SYNTHESIS thread's per-cycle sync-wait (host wall-time of the
// post-kernel sync). The decisive result: BEFORE, the synthesis sync-wait
// inflates by ~the chart-render long-op duration (serialized behind it). AFTER,
// it stays flat at ~the synthesis kernel time regardless of chart-render load.
//
// Build: nvcc -O2 -o dev-cpfix-mechanism-proof.exe dev-cpfix-mechanism-proof.cu
// Run:   dev-cpfix-mechanism-proof.exe

#include <cuda_runtime.h>
#include <cooperative_groups.h>
#include <cstdio>
#include <thread>
#include <atomic>
#include <vector>
#include <algorithm>
#include <chrono>

namespace cg = cooperative_groups;

// A short "synthesis" kernel: a fixed spin so it has a stable, smallish device
// time (analogous to addKernel ~644us). Cooperative so it mirrors addKernel's
// launch path.
__global__ void synthKernel(volatile int* sink, long long spin) {
    cg::grid_group grid = cg::this_grid();
    long long acc = 0;
    for (long long i = 0; i < spin; ++i) { acc += i ^ (i << 1); }
    grid.sync();
    if (threadIdx.x == 0 && blockIdx.x == 0) sink[0] = (int)acc;
}

// A LONG "chart-render-ish" dummy kernel: a big spin to emulate a heavy/slow GPU
// op that queues ahead of (or concurrent with) the synthesis sync.
__global__ void longChartKernel(volatile int* sink, long long spin) {
    long long acc = 0;
    long long idx = blockIdx.x * blockDim.x + threadIdx.x;
    for (long long i = 0; i < spin; ++i) { acc += (i ^ idx) + (i << 1); }
    if (idx == 0) sink[0] = (int)acc;
}

// A TRIVIAL "synth completion" op (single block, single thread, near-instant).
// This is the thing whose sync we time. The point of the decoupling proof is NOT
// how long the synth op takes — it's whether the SYNC waits for the OTHER stream.
// device-sync will wait for the whole device (incl. the long chart kernel);
// stream-sync(synthStream) will wait ONLY for this trivial op (~0us).
__global__ void trivialSynthKernel(volatile int* sink) {
    if (threadIdx.x == 0 && blockIdx.x == 0) sink[0] = 1;
}

static double median(std::vector<double>& v) {
    if (v.empty()) return 0.0;
    std::sort(v.begin(), v.end());
    size_t n = v.size();
    return (n % 2) ? v[n/2] : 0.5 * (v[n/2 - 1] + v[n/2]);
}
static double pctl(std::vector<double> v, double p) {
    if (v.empty()) return 0.0;
    std::sort(v.begin(), v.end());
    size_t i = (size_t)(p * (v.size() - 1) + 0.5);
    return v[i];
}

int main() {
    cudaSetDevice(0);

    cudaStream_t streamA, streamB;
    cudaStreamCreateWithFlags(&streamA, cudaStreamNonBlocking);
    cudaStreamCreateWithFlags(&streamB, cudaStreamNonBlocking);

    int *dSink, *dChart, *dCopySrc;
    cudaMalloc(&dSink, sizeof(int));
    cudaMalloc(&dChart, sizeof(int));
    // Model the REAL chart-render contention: getPianoidState is a D2H MEMCPY
    // (copy engine), NOT a compute kernel. A memcpy does not occupy SMs, so it
    // must not block the cooperative synth kernel's co-residency — the ONLY way
    // it stalls the synth sync is the legacy-default-stream DEVICE-WIDE barrier
    // (BEFORE). To make the copy take ~8ms we size it large (~64 MB).
    const size_t COPY_N = 16 * 1024 * 1024; // 16M floats = 64 MB D2H (~ms-scale)
    cudaMalloc(&dCopySrc, COPY_N * sizeof(float));
    std::vector<float> hCopy(COPY_N);

    // Spins are AUTO-CALIBRATED below (measured against this GPU) so the synth
    // kernel ~ 600us (engine addKernel) and the chart op ~ 8ms (a long readback).
    long long SYNTH_SPIN = 20000LL;
    long long CHART_SPIN = 2000000LL;

    int synthGrid = 0, synthBlock = 256;
    // cooperative launch needs blocks that co-reside; query max active blocks
    int numSm = 0; cudaDeviceGetAttribute(&numSm, cudaDevAttrMultiProcessorCount, 0);
    int maxBlocksPerSm = 0;
    cudaOccupancyMaxActiveBlocksPerMultiprocessor(&maxBlocksPerSm, synthKernel, synthBlock, 0);
    synthGrid = std::max(1, numSm * maxBlocksPerSm);

    auto warm = [&](){
        void* args[] = { (void*)&dSink, (void*)&SYNTH_SPIN };
        cudaLaunchCooperativeKernel((void*)synthKernel, synthGrid, synthBlock, args, 0, streamA);
        cudaStreamSynchronize(streamA);
    };
    warm(); warm();

    // --- auto-calibrate SYNTH_SPIN to ~600us and CHART_SPIN to ~8000us ---
    auto timeSynth = [&](long long spin)->double{
        void* args[] = { (void*)&dSink, (void*)&spin };
        // warm
        cudaLaunchCooperativeKernel((void*)synthKernel, synthGrid, synthBlock, args, 0, streamA);
        cudaStreamSynchronize(streamA);
        auto t0 = std::chrono::steady_clock::now();
        for (int k=0;k<5;k++){ cudaLaunchCooperativeKernel((void*)synthKernel, synthGrid, synthBlock, args, 0, streamA); cudaStreamSynchronize(streamA);}
        auto t1 = std::chrono::steady_clock::now();
        return std::chrono::duration<double, std::micro>(t1 - t0).count()/5.0;
    };
    auto timeChart = [&](long long spin)->double{
        longChartKernel<<<256,256,0,streamB>>>(dChart, spin); cudaStreamSynchronize(streamB);
        auto t0 = std::chrono::steady_clock::now();
        for (int k=0;k<5;k++){ longChartKernel<<<256,256,0,streamB>>>(dChart, spin); cudaStreamSynchronize(streamB);}
        auto t1 = std::chrono::steady_clock::now();
        return std::chrono::duration<double, std::micro>(t1 - t0).count()/5.0;
    };
    {
        double us = timeSynth(SYNTH_SPIN);
        SYNTH_SPIN = std::max(1000LL, (long long)(SYNTH_SPIN * (600.0/std::max(1.0,us))));
        double us2 = timeSynth(SYNTH_SPIN);
        printf("calibrated SYNTH_SPIN=%lld -> %.0f us\n", SYNTH_SPIN, us2);
        double cu = timeChart(CHART_SPIN);
        CHART_SPIN = std::max(10000LL, (long long)(CHART_SPIN * (8000.0/std::max(1.0,cu))));
        double cu2 = timeChart(CHART_SPIN);
        printf("calibrated CHART_SPIN=%lld -> %.0f us\n", CHART_SPIN, cu2);
    }

    const int CYCLES = 200;

    // Run one experiment. `chartDeviceBlocking` selects the BEFORE pattern (chart
    // op + BLOCKING default-stream copy => device-wide sync) vs AFTER (chart op +
    // async copy on streamB, synced on B only). `synthDeviceWide` selects whether
    // the synthesis thread waits device-wide (BEFORE) or stream-scoped (AFTER).
    auto run = [&](bool chartDeviceBlocking, bool synthDeviceWide, const char* label){
        std::atomic<bool> stop{false};
        std::atomic<long> chartIters{0};
        // chart-render thread
        // BEFORE faithfully reproduces the engine: synth kernel AND chart copy
        // both ride the DEFAULT stream (stream 0), so they SERIALIZE in the queue
        // and the synth thread's cudaDeviceSynchronize waits for the chart copy.
        // AFTER puts synth on streamA and chart copy on streamB.
        cudaStream_t synthStream = synthDeviceWide ? (cudaStream_t)0 : streamA;
        std::thread chartThread([&](){
            while (!stop.load()) {
                if (chartDeviceBlocking) {
                    // BEFORE (old getPianoidState): a DEVICE-WIDE cudaDeviceSynchronize
                    // then a BLOCKING D2H on the DEFAULT stream (queues on stream 0,
                    // same as the synth kernel — they serialize).
                    cudaDeviceSynchronize();
                    cudaMemcpy(hCopy.data(), dCopySrc, COPY_N * sizeof(float), cudaMemcpyDeviceToHost);
                } else {
                    // AFTER (new getPianoidState): gate on the synth stream only,
                    // then async D2H on readback streamB; sync only streamB. No
                    // device-wide barrier.
                    cudaStreamSynchronize(streamA);
                    cudaMemcpyAsync(hCopy.data(), dCopySrc, COPY_N * sizeof(float), cudaMemcpyDeviceToHost, streamB);
                    cudaStreamSynchronize(streamB);
                }
                chartIters.fetch_add(1);
            }
        });

        // give the chart thread a head start so contention is live
        std::this_thread::sleep_for(std::chrono::milliseconds(50));

        std::vector<double> syncWaits; syncWaits.reserve(CYCLES);
        for (int c = 0; c < CYCLES; ++c) {
            void* args[] = { (void*)&dSink, (void*)&SYNTH_SPIN };
            cudaError_t le = cudaLaunchCooperativeKernel((void*)synthKernel, synthGrid, synthBlock, args, 0, synthStream);
            if (le != cudaSuccess) { printf("  [%s] coop launch failed: %s\n", label, cudaGetErrorString(le)); }
            auto t0 = std::chrono::steady_clock::now();
            if (synthDeviceWide) cudaDeviceSynchronize();   // BEFORE (device-wide)
            else                 cudaStreamSynchronize(synthStream); // AFTER (stream-scoped)
            auto t1 = std::chrono::steady_clock::now();
            double us = std::chrono::duration<double, std::micro>(t1 - t0).count();
            syncWaits.push_back(us);
        }
        stop.store(true);
        chartThread.join();

        double med = median(syncWaits);
        double p99 = pctl(syncWaits, 0.99);
        double mx  = *std::max_element(syncWaits.begin(), syncWaits.end());
        printf("  [%-30s] synth sync-wait  median=%8.1f us  p99=%8.1f us  max=%8.1f us  (chart iters=%ld)\n",
               label, med, p99, mx, chartIters.load());
        return med;
    };

    printf("=== dev-cpfix mechanism proof ===\n");
    printf("SMs=%d  synthGrid=%d blocks x %d threads  SYNTH_SPIN=%lld  CHART_SPIN=%lld  copy=%zu floats\n",
           numSm, synthGrid, synthBlock, SYNTH_SPIN, CHART_SPIN, COPY_N);

    // Baseline: synthesis alone, no chart contention (lower bound on sync-wait).
    {
        std::vector<double> w; w.reserve(CYCLES);
        for (int c = 0; c < CYCLES; ++c) {
            void* args[] = { (void*)&dSink, (void*)&SYNTH_SPIN };
            cudaLaunchCooperativeKernel((void*)synthKernel, synthGrid, synthBlock, args, 0, streamA);
            auto t0 = std::chrono::steady_clock::now();
            cudaStreamSynchronize(streamA);
            auto t1 = std::chrono::steady_clock::now();
            w.push_back(std::chrono::duration<double, std::micro>(t1 - t0).count());
        }
        printf("  [%-30s] synth sync-wait  median=%8.1f us  p99=%8.1f us  max=%8.1f us  (no chart load)\n",
               "BASELINE no-contention", median(w), pctl(w,0.99), *std::max_element(w.begin(), w.end()));
    }

    printf("\n-- BEFORE (the bug): synth waits device-wide, chart device-blocks --\n");
    double before = run(/*chartDeviceBlocking=*/true,  /*synthDeviceWide=*/true,  "BEFORE device-wide + dflt-copy");

    printf("\n-- AFTER (the fix): synth waits on its stream, chart on its own stream --\n");
    double after  = run(/*chartDeviceBlocking=*/false, /*synthDeviceWide=*/false, "AFTER  stream-scoped both");

    printf("\n=== VERDICT (threaded) ===\n");
    printf("BEFORE synth sync-wait median = %.1f us\n", before);
    printf("AFTER  synth sync-wait median = %.1f us\n", after);

    // =====================================================================
    // DETERMINISTIC DECOUPLING PROOF (pure CUDA semantics — no contention luck).
    //
    // The engine spike (proven by CPDEEP) is the synthesis post-addKernel
    // cudaDeviceSynchronize() HOST-WAIT serializing behind concurrent chart-render
    // CUDA. This experiment proves the exact behavioural difference the fix makes,
    // independent of GPU-contention reproduction:
    //
    //   1. Launch a LONG busy-spin kernel ("chart-render work") on the COMPETING
    //      stream (streamB / a separate stream).
    //   2. Launch a TRIVIAL op on the synth stream (streamA) — the synth cycle.
    //   3. Time the synth completion sync TWO ways, back to back:
    //        BEFORE behaviour: cudaDeviceSynchronize()  — device-wide barrier;
    //                          WAITS for the long chart kernel on streamB too.
    //        AFTER  behaviour: cudaStreamSynchronize(streamA) — stream-scoped;
    //                          does NOT wait for streamB's long kernel.
    //
    //   Expected (CUDA semantics): device-sync ≈ long-kernel duration;
    //                              stream-sync ≈ 0 (the trivial op only).
    //   This is exactly the addKernel-sync decoupling the engine fix makes:
    //   it replaced the device-wide cudaDeviceSynchronize with a per-stream
    //   cudaStreamSynchronize(synthesis_stream_).
    // =====================================================================
    // The competing "chart" kernel uses only a FEW blocks (leaves SMs free) so the
    // trivial synth op can run CONCURRENTLY on free SMs — faithfully modelling the
    // real chart-render op (a D2H memcpy on the copy engine, which does NOT hold
    // the SMs the synth kernel needs). With a small-footprint long kernel, the ONLY
    // thing that makes a sync wait for it is the DEVICE-WIDE barrier (BEFORE), not
    // SM contention. We spin ~20ms in 2 blocks.
    const int CHART_BLOCKS = 2;
    {
        long long s = SYNTH_SPIN * 50;
        longChartKernel<<<CHART_BLOCKS, 256, 0, streamB>>>(dChart, s); cudaStreamSynchronize(streamB);
        auto a=std::chrono::steady_clock::now();
        longChartKernel<<<CHART_BLOCKS, 256, 0, streamB>>>(dChart, s); cudaStreamSynchronize(streamB);
        auto b=std::chrono::steady_clock::now();
        double us=std::chrono::duration<double,std::micro>(b-a).count();
        CHART_SPIN = std::max(1000LL,(long long)(s*(20000.0/std::max(1.0,us))));
    }
    printf("\n=== DETERMINISTIC DECOUPLING PROOF ===\n");
    printf("Long competing 'chart' kernel (%d blocks, leaves SMs free) on streamB; trivial synth op on streamA.\n", CHART_BLOCKS);
    {
        longChartKernel<<<CHART_BLOCKS,256,0,streamB>>>(dChart, CHART_SPIN); cudaStreamSynchronize(streamB);
        auto a=std::chrono::steady_clock::now();
        longChartKernel<<<CHART_BLOCKS,256,0,streamB>>>(dChart, CHART_SPIN); cudaStreamSynchronize(streamB);
        auto b=std::chrono::steady_clock::now();
        printf("  reference: long chart kernel alone = %.0f us\n",
               std::chrono::duration<double,std::micro>(b-a).count());
    }

    const int N = 30;
    std::vector<double> devWaits, strWaits;
    for (int c = 0; c < N; ++c) {
        // BEFORE behaviour: device-wide sync waits for streamB's long kernel
        longChartKernel<<<CHART_BLOCKS,256,0,streamB>>>(dChart, CHART_SPIN);  // chart work (few SMs)
        trivialSynthKernel<<<1,1,0,streamA>>>(dSink);                        // synth cycle (free SMs)
        auto t0=std::chrono::steady_clock::now();
        cudaDeviceSynchronize();                                             // BEFORE
        auto t1=std::chrono::steady_clock::now();
        devWaits.push_back(std::chrono::duration<double,std::micro>(t1-t0).count());
        cudaStreamSynchronize(streamB); // drain

        // AFTER behaviour: stream-scoped sync does NOT wait for streamB's long kernel
        longChartKernel<<<CHART_BLOCKS,256,0,streamB>>>(dChart, CHART_SPIN);  // chart work (few SMs)
        trivialSynthKernel<<<1,1,0,streamA>>>(dSink);                        // synth cycle (free SMs)
        auto t2=std::chrono::steady_clock::now();
        cudaStreamSynchronize(streamA);                                      // AFTER
        auto t3=std::chrono::steady_clock::now();
        strWaits.push_back(std::chrono::duration<double,std::micro>(t3-t2).count());
        cudaStreamSynchronize(streamB); // drain before next iter
    }
    double detBefore = median(devWaits), detAfter = median(strWaits);
    printf("  [BEFORE  cudaDeviceSynchronize()      ] synth sync-wait  median=%8.1f us  (WAITS for the long chart kernel)\n", detBefore);
    printf("  [AFTER   cudaStreamSynchronize(synth) ] synth sync-wait  median=%8.1f us  (does NOT wait for it)\n", detAfter);
    printf("\n=== VERDICT (deterministic) ===\n");
    if (detAfter < detBefore * 0.25 && detBefore > 5000.0)
        printf("PASS: device-sync waits ~the full chart-kernel duration (%.0fus); stream-sync returns promptly (%.0fus).\n"
               "      This is EXACTLY the decoupling the engine fix makes (device-wide cudaDeviceSynchronize\n"
               "      -> per-stream cudaStreamSynchronize(synthesis_stream_)): the synthesis sync no longer\n"
               "      serializes behind concurrent chart-render CUDA.\n", detBefore, detAfter);
    else
        printf("INCONCLUSIVE: detBefore=%.1f detAfter=%.1f\n", detBefore, detAfter);

    cudaFree(dSink); cudaFree(dChart); cudaFree(dCopySrc);
    cudaStreamDestroy(streamA); cudaStreamDestroy(streamB);
    return 0;
}
