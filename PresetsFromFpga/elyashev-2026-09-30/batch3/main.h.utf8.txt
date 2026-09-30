/*_______________________________________________________

		   H H Start 					     Stop
cmd_str		      		01 C 00 06 AA DDDD
cmd_pedal		  		01 C 00 01 D
cmd_reset		  		01 C 00 01 D
cmd_midi		  		01 C 00 02 DD        


________________________________________________________
*/

#define   SampleFrequency   44100  

#define Pianoid_low_nota  1
#define Pianoid_hi_nota  86 

#define Num_of_transducers 6

#define cmd0_sdvig_in    	172;//172 for lvds connection ;226 for master-half
#define cmd0_sdvig     		0xA1
#define cmd0_str_tripple    0xA2
#define cmd0_reset   		0xA3
#define cmd0_pedal   		0xA4
#define cmd0_midi    		0xA5
#define cmd0_gain    		0xA6
#define cmd0_mol_vol   		0xA7
#define cmd0_Ci_out   		0xA8
#define cmd0_Ci_1_out   	0xE5 

#define cmd0_Ci_coeff	   	0xA9
#define cmd0_omega	   		0xA0 
#define cmd0_listen	   		0xB0
#define cmd0_cfeed	   		0xB1
#define cmd0_amp_sryv	   	0xAB
#define cmd0_CHECK			0xAA

#define cmd0_transmit_sel	   	0xB2
#define cmd0_omega_test	   		0xB3
#define cmd0_decr_test	   	0xB4
#define cmd0_Ci_str	   		0xB5
#define cmd0_grp_num 		0xB6   
#define cmd0_Force 		0xB7   
#define cmd0_fb_input 		0xB8
#define cmd0_Q_coefss 		0xB9
#define cmd0_Q_1_coefss		0xCA
#define cmd0_tripple_block	0xBA

#define cmd0_flash_prog		0xBB
#define cmd0_load			0xBC 
#define cmd0_slice			0xBD
#define cmd0_test		0xBE

#define cmd_MIDI_display 0x40

#define cmd0_FRQ		0xBF
#define cmd0_toggle_fb		0xC3 
//#define cmd0_decr_integral		0xC4 
#define cmd0_shape		0xC5 
#define cmd0_FB_test		0xC6
#define cmd0_Mult_decr		0xC7
#define cmd0_notes_off		0xC8 
#define cmd0_write_coeffs   0xC9

#define cmd0_erase  			0xD0 
#define cmd0_write  			0xD1
#define cmd0_send_preset  		0xD3
#define cmd0_ind_mult_write		0xD4
#define cmd0_ind_vol_write		0xD5
#define cmd0_INIT				0xD6 
#define cmd0_omega_write		0xD7
#define cmd0_Q_coefss_write		0xD8
#define cmd0_Q_1_coefss_write	0xD9

#define cmd0_Ci_out_write		0xDA
#define cmd0_Ci_1_out_write		0xDB
#define cmd0_force_graph_write	0xDC 
#define cmd0_Ci_coeff_write		0xDD
#define cmd0_Ci_str_write		0xDE
#define cmd0_fir_write		    0xDF
#define cmd0_fir_1_write		0xEA
#define cmd0_Gain_write			0xEB 
#define cmd0_FB_write			0xEC 
#define cmd0_read  				0xD2

#define cmd_str0  0x00
#define cmd_str1  0x01
#define cmd_str2  0x02
#define cmd_str3  0x03
#define cmd_str4  0x04
#define cmd_str5  0x05
#define cmd_str6  0x06
#define cmd_str7  0x07
#define cmd_str8  0x08

#define cmd_str9  0x09
#define cmd_str10  0x0A
#define cmd_str11  0x0B
#define cmd_str12  0x0C
#define cmd_str13  0x0D

#define cmd_str11_0  0xE0 
#define cmd_str11_1  0xE1 

#define cmd_str17_0  0xE2 
#define cmd_str17_1  0xE3

#define cmd0_nl_sl  0xE3
#define cmd_str14  0x0E
#define cmd_str15  0x0F
#define cmd_str16  0x10
#define cmd_str17  0x11
#define cmd_str18  0x12
#define cmd_str19  0x13
#define cmd_str20  0x14
#define cmd_str21  0x15

#define cmd_window   0x0A
#define cmd_mol_vol_1  0x20
#define cmd_mol_ind_1  0x21
#define cmd_force_mol  0x22
#define cmd_FRQ_mol  0x23
#define cmd_Q_mol  0x24
#define cmd_L_Q_mol  0x25
#define cmd_graph_m  0x26
#define cmd_total_vol  0x27 
 #define CMD_recieve_ttn  0x28

#define cmd_zero_coef  0x30

#define cmd0_force_graph  0x29


#define cmd_disp0       0x0C
#define cmd_disp_decr0  0x0D
#define cmd_disp1       0x0E
#define cmd_disp_decr1  0x0F
#define cmd_fir_prg     0x10
#define cmd_fir_we      0x11
#define cmd_fir_we1     0x12
#define cmd_fir_we2  	0x13
#define cmd_fir_we3     0x14
#define cmd_disp_decr4  0x15
#define cmd_disp5       0x16
#define cmd_disp_decr5  0x17
#define cmd_disp6       0x18
#define cmd_disp_decr6  0x19
#define cmd_disp7       0x1A
#define cmd_disp_decr7  0x1B

#define cmd0_flash_prog_on_off  0xC0
#define cmd0_fir_on_off  0xC1
#define cmd0_fir_gain 0xC2
#define cmd0_fir  0xC4
#define cmd0_fir_1  0xE4 

#define cmd_pedal  0x1E


#define cmd_midi  0x80 




#define  NumString 88
#define  DataLength 1024

#define num_param 9
#define harm_num 256
#define deka_harm_num 15

#define start_dupple_note 16

#define start_tripple_note 28

#define Num_Points_Test 256

#define Fir_length  8192

/*

///////////////////////////////////////////////////////////////

#define CMD_ind_mult   1
#define CMD_ind_mult_1   2
#define CMD_ind_mult_2   3
#define CMD_ind_mult_3   4
#define CMD_ind_mult_4   5

#define CMD_force_graph   6
#define CMD_force_graph_1   7
#define CMD_force_graph_2   8
#define CMD_force_graph_3   9
#define CMD_force_graph_4   10

#define CMD_force_graph_first   11
#define CMD_force_graph_first_1   12
#define CMD_force_graph_first_2   13
#define CMD_force_graph_first_3   14
#define CMD_force_graph_first_4   15

#define CMD_force_graph_second   16
#define CMD_force_graph_second_1   17
#define CMD_force_graph_second_2   18
#define CMD_force_graph_second_3   19
#define CMD_force_graph_second_4   20

#define CMD_ind_vol   21
#define CMD_ind_vol_1   22
#define CMD_ind_vol_2   23
#define CMD_ind_vol_3   24
#define CMD_ind_vol_4   25

#define CMD_shape_0   26
#define CMD_shape_1   27
#define CMD_shape_2   28
#define CMD_shape_3   29
#define CMD_shape_4   30
#define CMD_shape_5   31
#define CMD_shape_6   32
#define CMD_shape_7   33
#define CMD_shape_8   34
#define CMD_shape_9   35
#define CMD_shape_10   36
#define CMD_shape_11   37
#define CMD_shape_12   38
#define CMD_shape_13   39
#define CMD_shape_14   40
#define CMD_shape_15   41
#define CMD_shape_16   42
#define CMD_shape_17   43
#define CMD_shape_18   44
#define CMD_shape_19   45
#define CMD_shape_20   46
#define CMD_shape_21   47

#define CMD_param_0   48
#define CMD_param_1   49
#define CMD_param_2   50
#define CMD_param_3   51
#define CMD_param_4   52
#define CMD_param_5   53
#define CMD_param_6   54
#define CMD_param_7   55
#define CMD_param_8   56
#define CMD_param_9   57
#define CMD_param_10   58
#define CMD_param_11   59
#define CMD_param_12   60
#define CMD_param_13   61
#define CMD_param_14   62
#define CMD_param_15   63
#define CMD_param_16   64
#define CMD_param_17   65
#define CMD_param_18   66
#define CMD_param_19   67
#define CMD_param_20   68
#define CMD_param_21   69

#define CMD_ci_Re_0   70
#define CMD_ci_Re_1   71
#define CMD_ci_Re_2   72
#define CMD_ci_Re_3   73
#define CMD_ci_Re_4   74
#define CMD_ci_Re_5   75
#define CMD_ci_Re_6   76
#define CMD_ci_Re_7   77
#define CMD_ci_Re_8   78
#define CMD_ci_Re_9   79
#define CMD_ci_Re_10   80
#define CMD_ci_Re_11   81

#define CMD_omega_0   82
#define CMD_omega_1   83

#define CMD_decr_0   86
#define CMD_decr_1   87

#define CMD_ci_str_0   90
#define CMD_ci_str_1   91
#define CMD_ci_str_2   92
#define CMD_ci_str_3   93
#define CMD_ci_str_4   94
#define CMD_ci_str_5   95
#define CMD_ci_str_6   96
#define CMD_ci_str_7   97
#define CMD_ci_str_8   98
#define CMD_ci_str_9   99
#define CMD_ci_str_10   100
#define CMD_ci_str_11   101

#define CMD_FB_mult   102

#define CMD_pedal   103

#define CMD_rst   104



*/

#define CMD_ind_mult  1
#define CMD_ind_mult_1  2
#define CMD_ind_mult_2  3
#define CMD_ind_mult_3  4
#define CMD_ind_mult_4 5

#define CMD_force_graph  6
#define CMD_force_graph_1  7
#define CMD_force_graph_2   8  
#define CMD_force_graph_3   9  
#define CMD_force_graph_4   10  

#define CMD_force_graph_first   11  
#define CMD_force_graph_first_1   12  
#define CMD_force_graph_first_2   13  
#define CMD_force_graph_first_3   14  
#define CMD_force_graph_first_4   15  

#define CMD_force_graph_second   16  
#define CMD_force_graph_second_1   17  
#define CMD_force_graph_second_2   18  
#define CMD_force_graph_second_3   19  
#define CMD_force_graph_second_4   20  

#define CMD_ind_vol   21  
#define CMD_ind_vol_1   22  
#define CMD_ind_vol_2   23  
#define CMD_ind_vol_3   24  
#define CMD_ind_vol_4   25  

#define CMD_shape_0   26  
#define CMD_shape_1   27  
#define CMD_shape_2   28  
#define CMD_shape_3   29  
#define CMD_shape_4   30  
#define CMD_shape_5   31  
#define CMD_shape_6   32  
#define CMD_shape_7   33  
#define CMD_shape_8   34  
#define CMD_shape_9   35  
#define CMD_shape_10   36  
#define CMD_shape_11   37  
#define CMD_shape_12   38  
#define CMD_shape_13   39  
#define CMD_shape_14   40  
#define CMD_shape_15   41  
#define CMD_shape_16   42  
#define CMD_shape_17   43  
#define CMD_shape_18   44  
#define CMD_shape_19   45  
#define CMD_shape_20   46  
#define CMD_shape_21   47  
#define CMD_shape_22   48  
#define CMD_shape_23   49  
#define CMD_shape_24   50  
#define CMD_shape_25   51  
#define CMD_shape_26   52  
#define CMD_shape_27   53  
#define CMD_shape_28   54  
#define CMD_shape_29   55  
#define CMD_shape_30  56  
#define CMD_shape_31   57  
#define CMD_shape_32   58  
#define CMD_shape_33   59  
#define CMD_shape_34   60  
#define CMD_shape_35   61  
#define CMD_shape_36   62  
#define CMD_shape_37   63  
#define CMD_shape_38   64  
#define CMD_shape_39   65  
#define CMD_shape_40   66  
#define CMD_shape_41   67  
#define CMD_shape_42   68  
#define CMD_shape_43   69
#define CMD_shape_44   170 
#define CMD_shape_45   171 
#define CMD_shape_46   172 
#define CMD_shape_47   173 
#define CMD_shape_48   174 
#define CMD_shape_49   175 
#define CMD_shape_50   176 
#define CMD_shape_51   177 
#define CMD_shape_52   178 
#define CMD_shape_53   179 
#define CMD_shape_54   180 
#define CMD_shape_55   181 
#define CMD_shape_56   182 

#define CMD_param_0   70  
#define CMD_param_1   71  
#define CMD_param_2   72  
#define CMD_param_3   73  
#define CMD_param_4   74  
#define CMD_param_5   75  
#define CMD_param_6   76  
#define CMD_param_7   77  
#define CMD_param_8   78  
#define CMD_param_9   79  
#define CMD_param_10   80  
#define CMD_param_11   81  
#define CMD_param_12   82  
#define CMD_param_13   83  
#define CMD_param_14   84  
#define CMD_param_15   85  
#define CMD_param_16   86  
#define CMD_param_17   87  
#define CMD_param_18   88  
#define CMD_param_19   89  
#define CMD_param_20   90  
#define CMD_param_21   91  
#define CMD_param_22   92  
#define CMD_param_23   93  
#define CMD_param_24   94  
#define CMD_param_25   95  
#define CMD_param_26  96  
#define CMD_param_27   97  
#define CMD_param_28   98  
#define CMD_param_29   99  
#define CMD_param_30   100  
#define CMD_param_31   101  
#define CMD_param_32   102  
#define CMD_param_33   103  
#define CMD_param_34   104  
#define CMD_param_35   105  
#define CMD_param_36   106  
#define CMD_param_37   107  
#define CMD_param_38   108  
#define CMD_param_39   109  
#define CMD_param_40   110  
#define CMD_param_41   111  
#define CMD_param_42   112  
#define CMD_param_43   113  
#define CMD_param_44   114
#define CMD_param_45   183 
#define CMD_param_46   184 
#define CMD_param_47   185 
#define CMD_param_48   186 
#define CMD_param_49   187 
#define CMD_param_50   188 
#define CMD_param_51   189 
#define CMD_param_52   190 
#define CMD_param_53   191 
#define CMD_param_54   195 
#define CMD_param_55   196 
#define CMD_param_56   197 

#define CMD_ci_Re_0   115  
#define CMD_ci_Re_1   116  
#define CMD_ci_Re_2   117  
#define CMD_ci_Re_3   118  
#define CMD_ci_Re_4   119  
#define CMD_ci_Re_5   120  
#define CMD_ci_Re_6   121  
#define CMD_ci_Re_7   122  
#define CMD_ci_Re_8   123  
#define CMD_ci_Re_9   124  
#define CMD_ci_Re_10   125  
#define CMD_ci_Re_11   126  
#define CMD_ci_Re_12   127  
#define CMD_ci_Re_13   128  
#define CMD_ci_Re_14   129  
#define CMD_ci_Re_15   130  
#define CMD_ci_Re_16   131  
#define CMD_ci_Re_17  132  
#define CMD_ci_Re_18   133  
#define CMD_ci_Re_19   134  
#define CMD_ci_Re_20   135  
#define CMD_ci_Re_21   136 



#define CMD_ci_Re_0_1   170
#define CMD_ci_Re_1_1   171
#define CMD_ci_Re_2_1   172
#define CMD_ci_Re_3_1   173
#define CMD_ci_Re_4_1   174
#define CMD_ci_Re_5_1   175
#define CMD_ci_Re_6_1   176
#define CMD_ci_Re_7_1   177
#define CMD_ci_Re_8_1   178
#define CMD_ci_Re_9_1   179
#define CMD_ci_Re_10_1   180
#define CMD_ci_Re_11_1   181
#define CMD_ci_Re_12_1   182
#define CMD_ci_Re_13_1   183
#define CMD_ci_Re_14_1   184
#define CMD_ci_Re_15_1   185
#define CMD_ci_Re_16_1   186
#define CMD_ci_Re_17_1   187
#define CMD_ci_Re_18_1   188
#define CMD_ci_Re_19_1   189
#define CMD_ci_Re_20_1   190
#define CMD_ci_Re_21_1   191



#define CMD_ci_str_0   137  
#define CMD_ci_str_1   138  
#define CMD_ci_str_2   139  
#define CMD_ci_str_3   140  
#define CMD_ci_str_4   141  
#define CMD_ci_str_5   142  
#define CMD_ci_str_6   143  
#define CMD_ci_str_7   144  
#define CMD_ci_str_8   145  
#define CMD_ci_str_9   146  
#define CMD_ci_str_10   147  
#define CMD_ci_str_11   148  
#define CMD_ci_str_12   149  
#define CMD_ci_str_13   150  
#define CMD_ci_str_14   151  
#define CMD_ci_str_15   152  
#define CMD_ci_str_16   153  
#define CMD_ci_str_17   154  
#define CMD_ci_str_18   155  
#define CMD_ci_str_19   156  
#define CMD_ci_str_20  157  
#define CMD_ci_str_21   158 


#define CMD_ci_str_0_1   195
#define CMD_ci_str_1_1   196
#define CMD_ci_str_2_1   197
#define CMD_ci_str_3_1   198
#define CMD_ci_str_4_1   199
#define CMD_ci_str_5_1   200
#define CMD_ci_str_6_1   201
#define CMD_ci_str_7_1   202
#define CMD_ci_str_8_1   203
#define CMD_ci_str_9_1   204
#define CMD_ci_str_10_1   205
#define CMD_ci_str_11_1   206
#define CMD_ci_str_12_1   207
#define CMD_ci_str_13_1   208
#define CMD_ci_str_14_1   209
#define CMD_ci_str_15_1   210
#define CMD_ci_str_16_1   211
#define CMD_ci_str_17_1   212
#define CMD_ci_str_18_1   213
#define CMD_ci_str_19_1   214
#define CMD_ci_str_20_1  215
#define CMD_ci_str_21_1   216

#define CMD_ind_tail 193


#define CMD_reset  217
#define CMD_fb   218
#define CMD_nl   219
#define CMD_out_vol   220
#define CMD_gain   221
#define CMD_sdvig_f   222
#define CMD_str_svertk  223
#define CMD_molot_string  224


#define CMD_omega_0   159  
#define CMD_omega_1   160  

#define CMD_decr_0   161  
#define CMD_decr_1   162  

#define CMD_ci_str_out   163  

#define CMD_FB_mult   164  

#define CMD_pedal   165  

#define CMD_rst   166 

#define Max_Cell_x 32
#define Max_Cell_y 32
#define Max_voice_num 5

#define cmd0_voice0  				0xE1
#define cmd0_voice1  				0xE2
#define cmd0_voice2  				0xE4
#define cmd0_voice3  				0xF1
#define cmd0_voice4  				0xF2
#define cmd0_write_voice     		0xF3
#define cmd0_edit_voice 			0xF4



#define Picture_width  1280 
#define Picture_height 1024 

#define Preset 0

struct Voice
{
	unsigned short  nota;
	unsigned short vol;
	unsigned short point;
	unsigned short flag;
};

struct Voice voice[Max_voice_num][Max_Cell_x][Max_Cell_y];

double surface[Max_voice_num][Max_Cell_x][Max_Cell_y]; 

unsigned short voice_nota[Max_voice_num][Max_Cell_x][Max_Cell_y];
unsigned short voice_vol[Max_voice_num][Max_Cell_x][Max_Cell_y]; 
unsigned short voice_point[Max_voice_num][Max_Cell_x][Max_Cell_y]; 
unsigned short voice_flag[Max_voice_num][Max_Cell_x][Max_Cell_y];  
unsigned short voice_gliss[Max_voice_num][Max_Cell_x][Max_Cell_y]; 
unsigned short voice_noise[Max_voice_num][Max_Cell_x][Max_Cell_y]; 
unsigned short voice_single[Max_voice_num][Max_Cell_x][Max_Cell_y]; 
unsigned short voice_reset_tn[Max_voice_num][Max_Cell_x][Max_Cell_y];   

unsigned int surface_int[Max_voice_num][Max_Cell_x][Max_Cell_y];

unsigned int copied_cell[Max_voice_num]; 


////////////////////////////////////////////////////////////
//#define Fir_length  8192 
//#define Fir_length  12288

int forbid_notes_send = 0;

int shift_nota_val;

int Transmit_Command;
int Transmit_Command_1;
int volume;
int Controller[8];
int Cntrl_num;
int p2_prev = 0;;

static char dir_name[MAX_PATHNAME_LEN];
static char dir_name_fir[MAX_PATHNAME_LEN];  
static char dir_name_force[MAX_PATHNAME_LEN];  
unsigned int send_block_data[NumString*3]; 
int engine_num;
int dir_selected_flag = 0;
int dir_selected_flag_fir = 0; 
int dir_selected_flag_force = 0; 

int player_device; 

char letter_force; 
	
char letter; 
char letter_fir; 

double ttn_voice[3][NumString];   

double ttn[NumString];
double ttn_micro[NumString]; 
double ttn_Q[NumString];
double ttn_orig[NumString];  
double width[NumString];
double del[NumString];
double dt[NumString];
double shteg[NumString];
double shteg_pack4[3][NumString];
unsigned int fo_ind[NumString];
unsigned int fw_ind[NumString];
unsigned int fo_ind_temp[NumString];


double damping[NumString]; 

double decr_op[NumString];
double decr_cl[NumString];
double disp[NumString];
double decr_disp[NumString];

unsigned int frq_coef0[128];
unsigned int frq_coef1[128];
unsigned int q_coef0[128];
unsigned int q_coef1[128];
unsigned int mult_coef0[128];
unsigned int mult_coef1[128];
unsigned int mult_ind[NumString]; 
unsigned int mult_gain_ind[NumString];

int block_size;
int Com232_0;
int Com232_1; 
int Prog_Command,Shape_Command;
int Addr232;
int mode_addr_shift;
int single_addr_shift;

int real_time_monitor = 0;

unsigned char Dat232[DataLength];
int Length232;

int nota;
int vol;
int Harmonic;

int pedal_data[128];

double step[25];
int focus;
int r_focus;
int param_num;
double inputBuffer[NumString];

int event_counter =1;
double X[100];
double Y[100];
double XY[2][100];

///MOLOT
	double FRQ[128];
	double FRQ_nota[NumString];
	double Vol_IND[128];
	
	double ind_mult_0[128]; 
	double ind_mult_1[128];
	double ind_mult_2[128];
	double ind_mult_3[128];
	double ind_mult_4[128];
	double vol_table[128];
	
	double ind_vol_0[128];
	double ind_vol_1[128];
	double ind_vol_2[128];
	double ind_vol_3[128];
	double ind_vol_4[128];
	
	double ind_tail_0[128];
	double ind_tail_1[128];
	double ind_tail_2[128];
	double ind_tail_3[128];
	double ind_tail_4[128];
	
	double integr[128];
	double vol_curve[128]; 
///////////DEKA definition
	double A[NumString][12];
	double B[NumString][12];
	double Ci_coeff_sin[NumString][2*harm_num];
	double Ci_coeff_cos[NumString][2*harm_num];
	double Ci_coeff_cos_femap[NumString][harm_num]; 
	double Ci_coeff_str[NumString][2*harm_num];
	
	double Ci_coeff_cos_tmp[NumString][2*harm_num];
	double Ci_coeff_str_tmp[NumString][2*harm_num];
	
	double Ci_coeff_cos_ref[NumString][2*harm_num];
	double Ci_coeff_str_ref[NumString][2*harm_num];
	
	double temp_plot_coef[NumString];
	
	double FB[NumString];
	
	double Copy_ci_cos[harm_num];
	double Copy_ci_str[harm_num]; 
	
	

	double Amps_calculated[128],omega_calculated[128],Q_calculated[128];   
	
	double Ci_str[harm_num][NumString];
	double Ci_str_tmp[harm_num][NumString];
	double Ci_str_orig[harm_num][NumString];  

 	double Q_coeff[harm_num];
	double Q_coeff_measured[harm_num];  
	double Q_coeff_orig[harm_num]; 
	double Q_coef_temp[harm_num];
	double Q_coeff_tmp[harm_num];
	int Q_coeff_int[harm_num];
	double omega_coef[harm_num];
	double omega_coef_orig[harm_num]; 
	double omega_coef_adj[harm_num];
	double Ci_str_out[harm_num]; 
	double Ci_str_1_out[harm_num];
	double Ci_str_1_out_tmp[harm_num];
	int grp_num;
	int flag; 
	
	double Graph_force[4096];
	double CI_left_spline[128];
	
	double shape_1024[16][1024]; 
	double shape_512[88][512]; 
	
	int shape_to_flash[57][512]; 
	double shape_256[88][256];
	double shape_128[40][128];
	double shape_64[16][64];
	
	double Ci_str_curve[NumString];
	double Ci_str_curve_cos[NumString];
	
	double Notes_freqs[92]; 
	
	int read_mem_buff[6000];
	int flag_read_buff = 0;
	
	char send_array[1024*256];
	double notes_freqs[NumString];
	
	double AFX[harm_num];
	
	double frq_array[harm_num];
	int index[harm_num];
	
	double Force_graph_disp[harm_num]; 
	double Force_graph_disp_1[harm_num]; 
	double Force_graph_disp_2[harm_num]; 
	double Force_graph_disp_3[harm_num]; 
	double Force_graph_disp_4[harm_num];
	
	double Force_graph[harm_num];
	double Force_graph_first[harm_num]; 
	double Force_graph_second[harm_num]; 
	
	double Force_graph_1[harm_num];
	double Force_graph_first_1[harm_num]; 
	double Force_graph_second_1[harm_num]; 
	
	double Force_graph_2[harm_num];
	double Force_graph_first_2[harm_num]; 
	double Force_graph_second_2[harm_num]; 
	
	double Force_graph_3[harm_num];
	double Force_graph_first_3[harm_num]; 
	double Force_graph_second_3[harm_num]; 
	
	double Force_graph_4[harm_num];
	double Force_graph_first_4[harm_num]; 
	double Force_graph_second_4[harm_num];
	
	double Force_graph_2_0[harm_num]; 
	double Force_graph_2_1[harm_num];
	double Force_graph_2_2[harm_num];
	double Force_graph_2_3[harm_num];
	double Force_graph_2_4[harm_num]; 
	double Force_graph_2_5[harm_num]; 
	double Force_graph_2_6[harm_num]; 
	double Force_graph_2_7[harm_num]; 
	
	
	double Force_graph_3_0[harm_num]; 
	double Force_graph_3_1[harm_num];
	double Force_graph_3_2[harm_num];
	double Force_graph_3_3[harm_num];
	double Force_graph_3_4[harm_num]; 
	double Force_graph_3_5[harm_num]; 
	double Force_graph_3_6[harm_num]; 
	double Force_graph_3_7[harm_num]; 
	
	
	double Force_graph_4_0[harm_num]; 
	double Force_graph_4_1[harm_num];
	double Force_graph_4_2[harm_num];
	double Force_graph_4_3[harm_num];
	double Force_graph_4_4[harm_num];
	double Force_graph_4_5[harm_num];
	double Force_graph_4_6[harm_num];
	double Force_graph_4_7[harm_num];
	
	
	double amp_fb[deka_harm_num];
	int amp_fb_num[deka_harm_num];
	int amp_fb_num_index;
	int string_harm_num[NumString];
	int fb_harm_num[deka_harm_num];
	double deka_harm[deka_harm_num];
	double cur_exp[deka_harm_num]; 
	
	int visible_switch = -1;
	
	int hide_notes = 1;
	
	int fb_harmonic_select;
	
	double impulse_resp_Left[3*Fir_length];
	double impulse_resp_Right[3*Fir_length];

	double impulse_resp_Left_tmp[3*Fir_length];
	double impulse_resp_Right_tmp[3*Fir_length];

	double impulse_resp_Left_1[3*Fir_length];
	double impulse_resp_Right_1[3*Fir_length];
	
	
	double impulse_resp_L[Fir_length];
	double impulse_resp_R[Fir_length];
	double impulse_resp_L1[Fir_length];
	double impulse_resp_R1[Fir_length];
	double impulse_resp_L2[Fir_length];
	double impulse_resp_R2[Fir_length];
	
	double impulse_resp_L3[Fir_length];
	double impulse_resp_R3[Fir_length];
	
	double chemistry[NumString];   
	
	
	////////////////////////////////////////////////
	
	double model_time_vozb[10000];
	
	double Force_graph_TEMP[harm_num];
	
	double pp,p,mf,f,ff;
	double v_0,v_1,v_2,v_3,v_4;  
	
	double dynamic_ppp_v[9];
	
	double Gain_FB[2];
	
	int lo_nota_limit;
	int hi_nota_limit; 
	
	int lo_grp_num;
	int hi_grp_num;
	
	int elements;
	
	double force_curve_adj_up[256];
	double force_curve_adj_lo[256]; 
	double Force_graph_curve[256];

	double molot_msconds[11];
	double molot_msconds_y[11];
	
	double Amp_NL[88],Quan_NL[88],NL_disp[88];
	double NL[128];

	int trem; 
	
	double integral[128];
	double others[20];
	
	double copied_str_params[22] ;
	
	double copied_vol[NumString],copied_ind_mult[NumString],copied_Force_graph[256];
	
	double ci_out_multiplier[harm_num];
	double modes_amps[harm_num];
	double modes_amps_str[harm_num]; 
	double FB_loaded[NumString];
	double multiple_FB[NumString]; 
	double multiple_FB_str[NumString]; 
	int velocity[128];
	int flag_velocity;
	int phase_clk = 0;
	
	double modes_extr[harm_num][NumString];
	double modes_extr_str[harm_num][NumString];   
	
struct Fconstr
{
	double  x0;	//position
	double  x1; 
	double  x2;
	double  x3;
	double  x4;
	
	
	
	double e0;   //exponent
	double e1; 
	double e2;
	double e3; 
	double e4; 
	
	
	
	double A0;   //amp
	double A1; 
	double A2; 
	double A3; 
	double A4; 
	
	
	
};
	
struct Fconstr fcnstr[5][8];  // 5 dynamics - pp,p,mf,f,ff; 8 - okt_num	

struct Fconstr fcnstr_temp;

double Force_vozb[5][8][256];

double force_current[256];
	
	///////////////////////////////////
	
	double Xi_prev,Yi_prev;
	double Xi,Yi;
	int Xi_curr,Yi_curr;
	int dXi,dYi;
	int xCoordinate;
	int yCoordinate; 
	
	int flag_nota_on[88];
	int flag_voice_rec[Max_voice_num];  
	int flag_cursor;
	int flag_voice_editable[Max_voice_num];
	
	int Play_Edit_Mode;
	
	double fir_curve[3*Fir_length];
	double amplitudeSpectrum[2][3*Fir_length];
	double phaseSpectrum[2][3*Fir_length];
	
	int gamma_seq[NumString];
	
	int copied_region[Max_voice_num][Max_Cell_x][Max_Cell_y];
	
	int copied_region_w,copied_region_h;
	int pedal_input = 0;
	
	double spectrum_window;
	int num_blocks_analys;
	double rms;
	double rms_notes[NumString];
	int audio_buff_counter,audio_flag_start;
	int buffer_length;
	int num_channels;
	char WaveInput[100000];
	int okt_num;  
	int flag_adj_vol;
	double adj_vol_array[88];
	double equal_loud[88];
	
	int preset_array[80000];
	
	int num_ach_freq;
	
	double ach[2][1000000];
	
	double responce[100000];
	int audio_m0de_sel;
	
	int flag_click,clic_start;
	
	////////////exp
	
	double exp_e[5][5][88];
	double exp_d[5][5][88];
	double exp_a[5][5][88];
	double exp_a_tmp[5][5][88]; 
	int exp_num;
	double exp_temp[3][5][5];
	double exp_temp_2_copy[88]; 
	int active_cntrl;
	double scroll_step;
	double step_e,step_d,step_a;
	int level_to_copy;
	
	int level;
	double deconvol_L[3*Fir_length],deconvol_R[3*Fir_length]; 
	int cell_to_copy;
	
	double  Ci_out_temp[harm_num];
	int array_to_send[4096];
	
   int offs_scale = 0;    
   
   int init_dac[14];
   int right_click_counter =0;
   	double deck[16][3]; 
	
	double decka_coeff[16][harm_num],decka_coeff_temp[16][harm_num];
	int decka_coeff_vol[16][harm_num];
	int exp_2_write_flash[3][2][1024];
	
   int MUTE_mode;
   double mute_amps[harm_num],mute_amps_temp[harm_num],mute_amps_set[harm_num];
   int xint_prev;
   char *date; 
   double temp_transduser_array[16];
   double osc_array[44100],osc_array_1[44100];
   int adj_mode;   
   
   double alpha[88];
  int flag_audio;
  double audio_threshold_level;
  int osc_array_index;
  int threshold_start  = 0;
 double Foorce[128][10000];
 double Foorce_single[100000];
 double freq;
 double stop_freq;
 double amp_sp,amp_deka;
 double pedal_curve[128];
 int pedal_out[128];
 
 //double Shapee[88][256];
int window_type;

int  tr_led[16];  
int Pitch[88][3][4];
//[str in one note]
//length num_mashinka num_str start_point ]		   num_mashinka <  0 - not exist
int mashinka_Pitch[57][3];
 double out_array[512]; 
 double Mass[harm_num];
 int copy_to_tr,copy_from_tr;
int Flag_Upload;
int btn_list_exibition[30] = {PANEL_LED_12,PANEL_LOAD,PANEL_COMMANDBUTTON_16,PANEL_TOGGLEBUTTON_11,PANEL_NUMERICTHERM_11,
							   PANEL_RING_6,PANEL_TOGGLEBUTTON,PANEL_RING_5, PANEL_NUMERIC_77, PANEL_NUMERIC_76,PANEL_NUMERICTHERM_3,
								PANEL_COMMANDBUTTON_55,PANEL_PRESET_NUM,PANEL_STRING};

int btn_list_attr[2][30];
int split_nota = 48;
int split_order = 0;
int split_on_off = 0; 
int Pedal_params[4]; 
