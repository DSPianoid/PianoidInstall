"""dev-1e95 Step B: apply the summed-form (position/velocity) leapfrog to MainKernel.cu + Kernels.cu in wt-1e95-core.
Algebraically identical to the 3-level form: v = u - u_prev;  dv = c_u*u + c1*(u[p-1]+u[p+1]) + c2*(u[p-2]+u[p+2])
 - dec2*v + cfd*(d3-d3_1) + F*cf;  v' = v + dv;  u' = u + v'   with c_u = (12B-2T)*dec_inv = shift_0-1+shift_b,
 dec2 = 2*dec*dec_inv = 1+shift_b. In float32 the small acceleration is accumulated into the small v instead of
 being rounded away against 2u-u_prev (the N^2-growing precision loss)."""
import sys, re
root = "D:/repos/wt-1e95-core/pianoid_cuda/"
k = open(root + "Kernels.cu").read()
old_k = "    parameters[rec_start_ind + (4 * arraySize) + i] = 1;  // t2\n"
new_k = ("    // dev-1e95 summed-form leapfrog coefficients (MainKernel inner loop): slot 4 = c_u = (12B - 2T)*dec_inv\n"
         "    // (= shift_0 - 1 + shift_b, computed here from the SMALL terms so float keeps full relative precision),\n"
         "    // slot 8 = dec2 = 2*dec*dec_inv (= 1 + shift_b; velocity damping per step). Slot 8 previously held\n"
         "    // coeff_E, which no kernel read.\n"
         "    parameters[rec_start_ind + (4 * arraySize) + i] = (12 * coeff_bending - 2 * coeff_tension) * dec_inv;  // c_u\n")
assert old_k in k; k = k.replace(old_k, new_k)
old_k2 = "    parameters[rec_start_ind + (8 * arraySize) + i] = coeff_E; // cF2\n"
new_k2 = "    parameters[rec_start_ind + (8 * arraySize) + i] = 2 * dec_curr * dec_inv; // dec2 (dev-1e95; was coeff_E, unread)\n"
assert old_k2 in k; k = k.replace(old_k2, new_k2)
open(root + "Kernels.cu", "w").write(k)
m = open(root + "MainKernel.cu").read()
old1 = "    real shift_F1 = parameters[start_ind + (6 * arraySize) + pointIndex];\n"
new1 = old1 + ("    // dev-1e95 summed-form leapfrog: c_u = (12B-2T)*dec_inv, dec2 = 2*dec*dec_inv (parameterKernel slots 4/8)\n"
               "    real coeff_u = parameters[start_ind + (4 * arraySize) + pointIndex];\n"
               "    real coeff_dec2 = parameters[start_ind + (8 * arraySize) + pointIndex];\n"
               "    // s_v = u - u_prev (per-step displacement increment). Carried in a register across sub-steps and\n"
               "    // samples; re-derived from the two stored time levels once per kernel launch (cycle).\n"
               "    real s_v = s_a[pointIndex] - s_b;\n")
assert old1 in m; m = m.replace(old1, new1)
old2 = ("                target *= shift_0;\n"
        "                target += s_b * shift_b;\n"
        "                target += (sa__2 + sa_2) * shift_2;\n"
        "                target += (sa__1 + sa_1) * shift_1;\n"
        "\n"
        "                target += (d3 - d3_1) * coeff_frequency_decay;\n"
        "                target += s_force_function[ff_start_index + j] * coeff_force;\n")
new2 = ("                // dev-1e95: summed form. Identical algebra to the 3-level update\n"
        "                //   shift_0*u + shift_b*u_prev + shift_1*(u[p-1]+u[p+1]) + shift_2*(u[p-2]+u[p+2]) + HF + force\n"
        "                // but the (small) acceleration is accumulated into the (small) increment s_v, and only then\n"
        "                // added to u. In float32 the old form rounded the acceleration away against 2u - u_prev once the\n"
        "                // per-sub-step increment fell below ~1e-7*|u| (bass strings at high string_iteration):\n"
        "                // pitch drift that grew with string_iteration and, with many coupled bass strings, a runaway.\n"
        "                real dv = target * coeff_u;\n"
        "                dv += (sa__2 + sa_2) * shift_2;\n"
        "                dv += (sa__1 + sa_1) * shift_1;\n"
        "                dv -= s_v * coeff_dec2;\n"
        "                dv += (d3 - d3_1) * coeff_frequency_decay;\n"
        "                dv += s_force_function[ff_start_index + j] * coeff_force;\n"
        "                s_v += dv;\n"
        "                target += s_v;\n")
assert old2 in m; m = m.replace(old2, new2)
# stem points: keep s_v consistent with the imposed displacement (not used for the stem update itself)
old3 = ("            if (onStem) {\n                target = feedback;\n            }\n\n            allThreads.sync();\n")
new3 = ("            if (onStem) {\n                target = feedback;\n                s_v = feedback - s_a[pointIndex];\n            }\n\n            allThreads.sync();\n")
assert old3 in m, "stem block"; m = m.replace(old3, new3)
open(root + "MainKernel.cu", "w").write(m)
print("summed-form patch applied (Kernels.cu slots 4/8; MainKernel.cu inner loop)")
