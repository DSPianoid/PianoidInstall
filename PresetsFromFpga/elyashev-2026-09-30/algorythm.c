void Calc_pianoid()
{
	int i,j;
	MyPresision dx_kv,p_dt_kv,decr_dt_dx_kv,e_dt_kv,f_d,str_sd,p_dt_kv_div_dx_kv,decr_dt,e_dt_kvdiv_dx_kv,div_dx_kv,beta_dx_kv;
	MyPresision next_plus_last,sd_sd;
	
	MyPresision sdd;
	
	MyPresision tdd,t_d;
	
	MyPresision ff,fff;
	MyPresision dec_Q;  

	
	dx_kv = dx*dx;
	
	div_dx_kv = I0/ dx_kv;
		
	p_dt_kv = p*dt*dt;
	
	decr_dt_dx_kv = decr*dt*dx*dx;
	
	e_dt_kv = E*dt*dt/(dx*dx);
	
	e_dt_kvdiv_dx_kv =  e_dt_kv/(dx*dx); 
	
	p_dt_kv_div_dx_kv = p_dt_kv/dx_kv;
	
	decr_dt = decr*dt;
	
	
	
	
	dec_Q = 100;
			for(i = 2; i < NumPoints - 2; i++)
					{
 		   	
							next_plus_last = Str1[i-1] + Str1[i+1];
					
							str_sd1[i] = next_plus_last - 2*Str1[i]; 

							str_fd1[i] = Str1[i-2] + Str1[i+2] - 4*(next_plus_last) +6*Str1[i];
							
							str_td1[i] = Str1[i+2] - Str1[i-2] + 2*( Str1[i-1] - Str1[i+1] );
							
				
							
										 sdd = (str_sd1[i] - str_sd0[i]);
										 beta_dx_kv = 0.1*beta/(dt*dt);
					
							ff =  str_sd1[i]*p_dt_kv_div_dx_kv - e_dt_kvdiv_dx_kv*str_fd1[i];

	 						//p_dt_kv_div_dx_kv - ttn
							//e_dt_kvdiv_dx_kv  - disp
							//beta_dx_kv decr_disp
	
								Str2[i] = 
								(
				
								
									2*Str1[i] - Str0[i] 
				
										+ ff
	 			
										+ Str0[i] *decr_dt 	
					
										+ force_calc*shape[i]
										
										+ beta_dx_kv*(производная по времени от второй производной по струне) 
								
								
								)/(1 + decr_dt);
					
				
					}
	
	force_last_point_temp = ff;
	

	
	switch(boundaries)
	{
		case 0:
			
			 Str2[0] = 0;
			 Str2[1] = 0;
		
			 Str2[NumPoints - 2] = 0;
			 Str2[NumPoints - 1] = 0;
			
		break;
		
		case 1:
			 Str2[0] = -1.0*Str2[2];
			 Str2[1] = 0;
		
			 Str2[NumPoints - 2] = 0;
			 Str2[NumPoints - 1] = -1.0*Str2[NumPoints - 3];	
		break;
		
		
	}
		   
		     
	
	
				for(i = 0; i < NumPoints; i++)
				{
					
					
					if(i = 179)
					{
						Str2[i] = 0;
						
					}
					if(i = 180)
					{
						Str2[i] = 0;
						
					}
					
					
					Str0[i]    =   Str1[i];
					Str1[i]    =   Str2[i];
					str_sd00[i] =   str_sd0[i];
					str_sd0[i] =   str_sd1[i];
					
					str_td00[i] = str_td0[i];
					str_td0[i] = str_td1[i];
					
					str_fd00[i] = str_fd0[i];
					str_fd0[i] = str_fd1[i];
	////////////////////////////////////////////////////////////				
					
					
					
				}	
	
		
}

