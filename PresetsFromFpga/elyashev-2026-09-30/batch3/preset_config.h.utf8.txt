#define ttn_offs 		0	
#define dt_offs 		88	
#define dec_op_offs		2*88	
#define dec_cl_offs		3*88
#define disp_offs		4*88
#define decr_disp_offs 	5*88
#define shteg_offs		6*88
#define damping_offs 	7*88
				  
#define shape_offs 		8*88

#define force_vozb_offs 8*88 + 256*88
#define ind_mult_offs   8*88 + 256*88 + 256*40
#define ind_vol_offs    8*88 + 256*88 + 256*40 + 88*5
#define ci_out_offs		8*88 + 256*88 + 256*40 + 88*5 + 88*5
#define omega_offs		8*88 + 256*88 + 256*40 + 88*5 + 88*5 + 128    
#define Q_offs			8*88 + 256*88 + 256*40 + 88*5 + 88*5 + 128 + 128 
#define Ci_cos_offs		8*88 + 256*88 + 256*40 + 88*5 + 88*5 + 128 + 128 + 128
#define ci_str_offs		8*88 + 256*88 + 256*40 + 88*5 + 88*5 + 128 + 128 + 128 + 44* 256


/*
ttn_offs = 0;
dt_offs =  ttn_offs + 88; 
dec_op_offs = dt_offs +88;		
dec_cl_offs = dec_op_offs + 88;	
disp_offs = dec_cl_offs + 88;	
decr_disp_offs = disp_offs + 88; 	
shteg_offs;	
damping_offs  = decr_disp_offs + 88;	
				  
shape_offs  = damping_offs + 88;		

force_vozb_offs = shape_offs +256*88; 
ind_mult_offs = force_vozb_offs + 256*40; 
ind_vol_offs = ind_mult_offs + 88; 
ci_out_offs = ind_vol_offs + 88;
omega_offs = ci_out_offs + 128;
Q_offs = omega_offs + 128;
Ci_cos_offs = Q_offs + 128;
ci_str_offs = Ci_cos_offs + 44* 256;


 */
