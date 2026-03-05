# String equation with decay

$\frac{\partial^2y}{\partial t^2}  =   u^{2}  \frac{\partial^2y}{\partial x^2} + EG\frac{\partial^4y}{\partial x^4}  + F - \gamma \frac{\partial y}{\partial t}$


### Differential scheme

$\frac{ y_{t+1} +  y_{t-1} - 2y_{0}}{\partial t^2}  = u^{2}  \frac{ y_{1} +  y_{-1} - 2y_{0}}{\partial x^2} + EG\frac{ y_{-2} + y_{2} - {-1} - 4y_{1} + 6y_{0}}{\partial x^4} - \gamma \frac{y_{0} - y_{t-1}}{\partial t} + F$

$y_{t+1} +  y_{t-1} - 2y_{0}  =  \frac{{u^{2}}{\partial t^2}}{\partial x^2}(y_{1} +  y_{-1} - 2y_{0}) + \frac{EG{\partial t^2}}{\partial x^4}(y_{-2} + y_{2} - 4y_{-1} - 4y_{1} + 6y_{0}) - \frac{\gamma{\partial t}}{2}(y_{t+1} - y_{t-1}) + F{\partial t^2}$


$y_{t+1}(1 + \gamma{\partial t})  =  \frac{{u^{2}}{\partial t^2}}{\partial x^2}(y_{1} +  y_{-1} - 2y_{0}) + \frac{EG{\partial t^2}}{\partial x^4}(y_{-2} + y_{2} - 4y_{-1} - 4y_{1} + 6y_{0}) + F{\partial t^2} + (\gamma{\partial t} - 1)y_{t-1} + 2y_{0}  $

$y_{t+1}  = \frac{\frac{EG{\partial t^2}}{\partial x^4}(y_{-2} + y_{2}) + (\frac{{u^{2}}{\partial t^2}}{\partial x^2} - 4\frac{EG{\partial t^2}}{\partial x^4})(y_{-1} + y_{1})  + (2 - 2\frac{{u^{2}}{\partial t^2}}{\partial x^2} + 6\frac{EG{\partial t^2}}{\partial x^4})y_{0} +  (\gamma{\partial t} - 1)y_{t-1} + F{\partial t^2}}{1 + \gamma{\partial t}}$

 ### Individual coefficients for the elements

 coefficient for the tension component $C_{tension}$

 $C_{tension} = \frac{{u^{2}}{\partial t^2}}{\partial x^2}$

 coefficient for the dispersion component $C_{disp}$


Moment of inertia

$G = \frac{mr^2}{4}$

$m = \rho\partial x$

 $C_{disp} = \frac{EG{\partial t^2}}{\partial x^4}$

 coefficient for the decay component $C_{dec}$

 $C_{dec} =  \gamma{\partial t}$


 coefficient for $(y_{-2} + y_{2})$

 $C_{2} = \frac{C_{disp}}{1 + C_{dec}}$


 coefficient for $(y_{-1} + y_{1})$

$C_{1} = \frac{C_{tension} - 4 C_{disp}}{(1 + C_{dec})}$

 coefficient for $y_{0}$

$C_{0} = \frac{2 - 2C_{tension} + 6C_{disp}}{(1 + C_{dec})}$

 coefficient for $y_{t-1}$

 $C_{t-1} = \frac{C_{dec} - 1}{C_{dec} + 1}$

 coefficient for the applied force $C_{F}$

 $C_{F} = \frac{\partial t^2}{C_{dec} + 1}$


 ## Computation formula

  $y_{t+1}  = C_{2}(y_{-2} + y_{2}) + C_{1}(y_{-1} + y_{1}) + C_{0}y_{0} + C_{t-1}y_{t-1} + C_{F}F$

 # Computation of force applied to the stem

$F_{stem}  = \frac{u^{2}}{\partial x^2}( y_{1} +  y_{-1} - 2y_{0}) + \frac{EG}{\partial x^4}( y_{-2} + y_{2} - 4y_{-1} - 4y_{1} + 6y_{0}) - \frac{\gamma}{\partial t}(y_{0} - y_{t-1}) + F$


 $F_{stem}  = \frac{EG}{\partial x^4}(y_{-2} + y_{2}) + (\frac{u^{2}}{\partial x^2} - 4\frac{EG}{\partial x^4})(y_{-1} - y_{1}) + (6\frac{EG}{\partial x^4} - 2\frac{u^{2}}{\partial x^2} - \frac{\gamma}{\partial t})y_{0} + \frac{\gamma}{\partial t}y_{t-1} + F$

 ### Individual coefficients for the elements

 coefficient for $(y_{-2} + y_{2})$

 $C_{f2} = \frac{C_{disp}}{\partial t^2}$

 coefficient for $(y_{-1} + y_{1})$

 $C_{f1} = \frac{C_{tension} - 4 C_{disp}}{\partial t^2}$

 coefficient for $y_{0}$

 $C_{f0} = \frac{6C_{disp} - 2C_{tension} - C_{dec}}{\partial t^2}$

 coefficient for $y_{t-1}$

 $C_{t-1} = \frac{\gamma}{\partial t}$


 ## Computation formula

 $F_{stem}  = C_{f2}(y_{-2} + y_{2}) + C_{f1}(y_{-1} + y_{1}) + C_{f0}y_{0} + C_{ft-1}y_{t-1} + F$
