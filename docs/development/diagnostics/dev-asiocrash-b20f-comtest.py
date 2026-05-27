"""dev-asiocrash-b20f: Test whether COM apartment init in worker thread fixes
the 2nd-ASIO-open failure. Reproduces the load_preset bug pattern: open ASIO,
close, open again — with various COM init strategies.

If any strategy makes the 2nd open succeed, that's the right fix. If all fail,
the proper fix is "reject re-init" (the chosen Phase A).
"""
import sys
import time
import threading
import os

REPO = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
sys.path.insert(0, os.path.join(REPO, "PianoidCore", "pianoid_middleware"))
os.chdir(os.path.join(REPO, "PianoidCore", "pianoid_middleware"))

import pianoidCuda  # noqa: E402

SAMPLE_RATE = 48000
SAMPLES_PER_CYCLE = 64
NUM_CHANNELS = 4
ADT_ASIO_CALLBACK = int(pianoidCuda.AudioDriverType.ASIO_CALLBACK)


def make_init_params():
    p = pianoidCuda.InitializationParameters()
    p.sample_rate = SAMPLE_RATE
    p.buffer_size = 4
    p.num_channels = NUM_CHANNELS
    p.mode_iteration = SAMPLES_PER_CYCLE
    p.audio_driver_type = ADT_ASIO_CALLBACK
    p.circular_buffer_chunks = 8
    p.num_strings = 1
    p.num_modes = 1
    p.array_size = 384
    p.sound_step = 6
    p.num_strings_in_array = 4
    p.fir_filter_length = 0
    p.listen_to_modes = 1
    p.mode_channel_index = 0
    p.sound_derivative_order = 1
    return p


def open_then_close(label):
    print(f"\n=== {label}: open ASIO ===", flush=True)
    init_params = make_init_params()
    strings = [21]  # 1 string
    try:
        p = pianoidCuda.Pianoid(strings, init_params)
        # Construction succeeds (no ASIO yet); driver init happens on startAudioDriver
        # We can't easily call startAudioDriver standalone — need devMemoryInit first.
        # So just construct, then destruct. If 2nd construct itself fails, we know.
        print(f"  Constructed Pianoid", flush=True)
        del p  # triggers destructor -> ~ASIOAudioDriver -> Close
        print(f"  Destructed Pianoid (Close called)", flush=True)
        return True
    except Exception as e:
        print(f"  FAILED: {type(e).__name__}: {e}", flush=True)
        return False


def open_init_close(label, with_engine_run=False):
    """Try full open->init->run cycle. Mimics what load_preset does."""
    print(f"\n=== {label}: full ASIO init cycle ===", flush=True)
    init_params = make_init_params()
    strings = list(range(1, 225))  # 224 strings, matches baseline
    try:
        p = pianoidCuda.Pianoid(strings, init_params)
        print(f"  Constructed Pianoid")
        # Allocate GPU memory
        n_strings = len(strings)
        # devMemoryInit signature: (state_0, state_1, exc_idx, fir_filters, stringMap, dec_open, max_volume, sustain)
        state_size = init_params.array_size * n_strings
        state_0 = [0.0] * state_size
        state_1 = [0.0] * state_size
        exc_idx = [0] * n_strings
        fir_filters = [0.0] * 0  # no filter
        string_map = [0] * (n_strings * 2)
        dec_open = [127] * n_strings
        p.devMemoryInit(state_0, state_1, exc_idx, fir_filters, string_map, dec_open, 10000.0, 127)
        print(f"  devMemoryInit OK")
        # Try startAudioDriver
        p.startAudioDriver()
        print(f"  startAudioDriver OK -> audio_driver_active={p.isAudioDriverActive()}")
        if with_engine_run:
            time.sleep(2.0)  # let callbacks fire
        p.stopAudioDriver()
        print(f"  stopAudioDriver OK")
        del p
        print(f"  Destructed Pianoid")
        return True
    except Exception as e:
        print(f"  FAILED: {type(e).__name__}: {e}", flush=True)
        return False


def test_no_com_init_same_thread():
    """Two consecutive opens on the same thread without explicit COM init."""
    print("\n##### TEST 1: Same thread, no explicit COM init #####")
    a = open_init_close("1st open")
    b = open_init_close("2nd open")
    print(f"RESULT: 1st={a}, 2nd={b}")
    return a, b


def test_com_apartment_thread():
    """Init COM as STA (apartment-threaded) before each ASIO call."""
    print("\n##### TEST 2: Same thread, CoInitializeEx APARTMENTTHREADED before each #####")
    import pythoncom
    try:
        pythoncom.CoInitializeEx(pythoncom.COINIT_APARTMENTTHREADED)
        a = open_init_close("1st open (STA)")
        # Re-init COM before 2nd
        pythoncom.CoUninitialize()
        pythoncom.CoInitializeEx(pythoncom.COINIT_APARTMENTTHREADED)
        b = open_init_close("2nd open (STA)")
    finally:
        try:
            pythoncom.CoUninitialize()
        except Exception:
            pass
    print(f"RESULT: 1st={a}, 2nd={b}")
    return a, b


def test_worker_threads():
    """Each open on a fresh thread with COM init."""
    print("\n##### TEST 3: Each open on its own worker thread with STA COM #####")
    results = []

    def worker(label):
        import pythoncom
        try:
            pythoncom.CoInitializeEx(pythoncom.COINIT_APARTMENTTHREADED)
            ok = open_init_close(label)
            results.append((label, ok))
        finally:
            try:
                pythoncom.CoUninitialize()
            except Exception:
                pass

    t1 = threading.Thread(target=worker, args=("1st open (STA, worker)",))
    t1.start(); t1.join()
    t2 = threading.Thread(target=worker, args=("2nd open (STA, worker)",))
    t2.start(); t2.join()
    print(f"RESULTS: {results}")
    return results


def test_cross_thread_open_close():
    """Open on thread W1, Close on main thread, Open on thread W2.
    This mimics the Flask pattern: open from background worker, close from
    request handler, open from new worker."""
    print("\n##### TEST 4: Cross-thread open/close (mimics Flask pattern) #####")
    # Open #1 from worker thread W1
    result1 = []
    p_holder = []

    def w1():
        p = pianoidCuda.Pianoid(list(range(1, 225)), make_init_params())
        p.devMemoryInit(
            [0.0] * (384 * 224), [0.0] * (384 * 224),
            [0] * 224, [], [0] * 448, [127] * 224, 10000.0, 127)
        p.startAudioDriver()
        print(f"  W1: startAudioDriver -> active={p.isAudioDriverActive()}")
        p_holder.append(p)
        result1.append(p.isAudioDriverActive())

    t1 = threading.Thread(target=w1, name="W1")
    t1.start()
    t1.join()
    print(f"  Thread W1 joined. Active={result1}")

    # Close from main thread
    time.sleep(0.5)
    if p_holder:
        p_holder[0].stopAudioDriver()
        print(f"  MAIN: stopAudioDriver done")
        del p_holder[0]
        print(f"  MAIN: deleted Pianoid #1")
    time.sleep(0.5)

    # Open #2 from worker thread W2
    result2 = []

    def w2():
        try:
            p = pianoidCuda.Pianoid(list(range(1, 225)), make_init_params())
            p.devMemoryInit(
                [0.0] * (384 * 224), [0.0] * (384 * 224),
                [0] * 224, [], [0] * 448, [127] * 224, 10000.0, 127)
            p.startAudioDriver()
            ok = p.isAudioDriverActive()
            print(f"  W2: startAudioDriver -> active={ok}")
            result2.append(ok)
            p.stopAudioDriver()
            del p
        except Exception as e:
            print(f"  W2 FAILED: {type(e).__name__}: {e}")
            result2.append(False)

    t2 = threading.Thread(target=w2, name="W2")
    t2.start()
    t2.join()
    print(f"  Thread W2 joined. Active={result2}")
    return result1, result2


def test_close_from_uninitialized_main():
    """Open on W1 (STA-initialized), Close from MAIN (NO COM init), Open on W2 (STA).
    This is the EXACT Flask pattern: open from background, close from request handler,
    open from new background. Tests whether the close-thread needs COM init."""
    print("\n##### TEST 7: Open W1 STA, Close MAIN no-COM, Open W2 STA #####")
    import pythoncom
    p_holder = []
    r1 = []

    def w1():
        try:
            pythoncom.CoInitializeEx(pythoncom.COINIT_APARTMENTTHREADED)
        except Exception:
            pass
        p = pianoidCuda.Pianoid(list(range(1, 225)), make_init_params())
        p.devMemoryInit(
            [0.0] * (384 * 224), [0.0] * (384 * 224),
            [0] * 224, [], [0] * 448, [127] * 224, 10000.0, 127)
        p.startAudioDriver()
        ok = p.isAudioDriverActive()
        print(f"  W1 STA: startAudioDriver -> active={ok}")
        p_holder.append(p)
        r1.append(ok)
        # NOTE: do NOT CoUninitialize — thread keeps COM apartment alive while p is held.

    t1 = threading.Thread(target=w1, name="W1-STA")
    t1.start(); t1.join()
    # W1 thread has exited. Its COM apartment was destroyed on exit.
    print(f"  W1 joined. ok={r1}")

    # Close from MAIN thread (no COM init at all in main)
    time.sleep(0.5)
    if p_holder:
        try:
            p_holder[0].stopAudioDriver()
            print(f"  MAIN (no-COM): stopAudioDriver returned")
            del p_holder[0]
            print(f"  MAIN: deleted Pianoid #1")
        except Exception as e:
            print(f"  MAIN: stop/del FAILED: {type(e).__name__}: {e}")
    time.sleep(0.5)

    r2 = []

    def w2():
        try:
            pythoncom.CoInitializeEx(pythoncom.COINIT_APARTMENTTHREADED)
        except Exception:
            pass
        try:
            p = pianoidCuda.Pianoid(list(range(1, 225)), make_init_params())
            p.devMemoryInit(
                [0.0] * (384 * 224), [0.0] * (384 * 224),
                [0] * 224, [], [0] * 448, [127] * 224, 10000.0, 127)
            p.startAudioDriver()
            ok = p.isAudioDriverActive()
            print(f"  W2 STA: startAudioDriver -> active={ok}")
            r2.append(ok)
            p.stopAudioDriver()
            del p
        except Exception as e:
            print(f"  W2 FAILED: {type(e).__name__}: {e}")
            r2.append(False)

    t2 = threading.Thread(target=w2, name="W2-STA")
    t2.start(); t2.join()
    print(f"  W2 joined. ok={r2}")
    return r1, r2


def test_close_from_initialized_main():
    """Same as test 7 but MAIN thread DOES have COM init."""
    print("\n##### TEST 8: Open W1 STA, Close MAIN STA, Open W2 STA #####")
    import pythoncom
    pythoncom.CoInitializeEx(pythoncom.COINIT_APARTMENTTHREADED)
    try:
        return test_close_from_uninitialized_main()
    finally:
        pythoncom.CoUninitialize()


def test_cross_thread_mta_com():
    """Open on W1, Close on W1, Open on W2 — with MTA COM init on BOTH threads.
    MTA threads share the same apartment, so ASIO state should persist across
    them. If this works, the fix is `pythoncom.CoInitializeEx(MTA)` in every
    thread that touches ASIO (worker thread AND main Flask thread for destroy)."""
    print("\n##### TEST 6: MTA COM init on every thread #####")
    import pythoncom

    # Init MTA on main thread too (so the apartment lives across worker threads)
    try:
        pythoncom.CoInitializeEx(pythoncom.COINIT_APARTMENTTHREADED)
        main_com_init = True
    except Exception as e:
        print(f"  MAIN CoInitializeEx failed: {e}")
        main_com_init = False

    r1 = []

    def w1():
        try:
            pythoncom.CoInitializeEx(pythoncom.COINIT_APARTMENTTHREADED)
        except Exception:
            pass
        try:
            p = pianoidCuda.Pianoid(list(range(1, 225)), make_init_params())
            p.devMemoryInit(
                [0.0] * (384 * 224), [0.0] * (384 * 224),
                [0] * 224, [], [0] * 448, [127] * 224, 10000.0, 127)
            p.startAudioDriver()
            print(f"  W1: startAudioDriver -> active={p.isAudioDriverActive()}")
            time.sleep(0.5)
            p.stopAudioDriver()
            print(f"  W1: stopAudioDriver done")
            r1.append(True)
            del p
        finally:
            try:
                pythoncom.CoUninitialize()
            except Exception:
                pass

    t1 = threading.Thread(target=w1, name="W1-MTA")
    t1.start(); t1.join()

    time.sleep(1.0)

    r2 = []

    def w2():
        try:
            pythoncom.CoInitializeEx(pythoncom.COINIT_APARTMENTTHREADED)
        except Exception:
            pass
        try:
            p = pianoidCuda.Pianoid(list(range(1, 225)), make_init_params())
            p.devMemoryInit(
                [0.0] * (384 * 224), [0.0] * (384 * 224),
                [0] * 224, [], [0] * 448, [127] * 224, 10000.0, 127)
            p.startAudioDriver()
            ok = p.isAudioDriverActive()
            print(f"  W2-MTA: startAudioDriver -> active={ok}")
            r2.append(ok)
            p.stopAudioDriver()
            del p
        except Exception as e:
            print(f"  W2-MTA FAILED: {type(e).__name__}: {e}")
            r2.append(False)
        finally:
            try:
                pythoncom.CoUninitialize()
            except Exception:
                pass

    t2 = threading.Thread(target=w2, name="W2-MTA")
    t2.start(); t2.join()

    if main_com_init:
        try:
            pythoncom.CoUninitialize()
        except Exception:
            pass
    print(f"  W1 ok={r1}, W2 ok={r2}")
    return r1, r2


def test_cross_thread_same_thread_close():
    """Open + Close on the SAME thread, but a different thread for next open.
    Tests whether ASIOExit must be on the same thread as ASIOInit."""
    print("\n##### TEST 5: Open+Close on W1, Open on W2 #####")
    r1 = []

    def w1():
        p = pianoidCuda.Pianoid(list(range(1, 225)), make_init_params())
        p.devMemoryInit(
            [0.0] * (384 * 224), [0.0] * (384 * 224),
            [0] * 224, [], [0] * 448, [127] * 224, 10000.0, 127)
        p.startAudioDriver()
        print(f"  W1: startAudioDriver -> active={p.isAudioDriverActive()}")
        time.sleep(0.5)
        p.stopAudioDriver()
        print(f"  W1: stopAudioDriver done")
        r1.append(True)
        del p
        print(f"  W1: deleted Pianoid #1")
    t1 = threading.Thread(target=w1, name="W1")
    t1.start(); t1.join()
    print(f"  W1 joined. ok={r1}")

    time.sleep(1.0)

    r2 = []

    def w2():
        try:
            p = pianoidCuda.Pianoid(list(range(1, 225)), make_init_params())
            p.devMemoryInit(
                [0.0] * (384 * 224), [0.0] * (384 * 224),
                [0] * 224, [], [0] * 448, [127] * 224, 10000.0, 127)
            p.startAudioDriver()
            ok = p.isAudioDriverActive()
            print(f"  W2: startAudioDriver -> active={ok}")
            r2.append(ok)
            p.stopAudioDriver()
            del p
        except Exception as e:
            print(f"  W2 FAILED: {type(e).__name__}: {e}")
            r2.append(False)

    t2 = threading.Thread(target=w2, name="W2")
    t2.start(); t2.join()
    print(f"  W2 joined. ok={r2}")
    return r1, r2


if __name__ == "__main__":
    print(f"Python: {sys.executable}")
    print(f"pianoidCuda from: {pianoidCuda.__file__}")
    # Pick test based on argv
    test = sys.argv[1] if len(sys.argv) > 1 else "1"
    if test == "1":
        test_no_com_init_same_thread()
    elif test == "2":
        test_com_apartment_thread()
    elif test == "3":
        test_worker_threads()
    elif test == "4":
        test_cross_thread_open_close()
    elif test == "5":
        test_cross_thread_same_thread_close()
    elif test == "6":
        test_cross_thread_mta_com()
    elif test == "7":
        test_close_from_uninitialized_main()
    elif test == "8":
        test_close_from_initialized_main()
    else:
        print(f"Unknown test: {test}")
