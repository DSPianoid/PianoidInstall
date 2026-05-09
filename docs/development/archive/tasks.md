###Task 1. Review and refactor Sound Channels panel
####1.1. Error
Uncaught runtime errors:
×
ERROR
Cannot read properties of null (reading 'row')
TypeError: Cannot read properties of null (reading 'row')
    at handleMouseDown (http://localhost:3000/static/js/bundle.js:247508:71)
    at onMouseDown (http://localhost:3000/static/js/bundle.js:247523:29)
    at HTMLUnknownElement.callCallback (http://localhost:3000/static/js/bundle.js:162906:18)
    at Object.invokeGuardedCallbackDev (http://localhost:3000/static/js/bundle.js:162950:20)
    at invokeGuardedCallback (http://localhost:3000/static/js/bundle.js:163007:35)
    at invokeGuardedCallbackAndCatchFirstError (http://localhost:3000/static/js/bundle.js:163021:29)
    at executeDispatch (http://localhost:3000/static/js/bundle.js:167164:7)
    at processDispatchQueueItemsInOrder (http://localhost:3000/static/js/bundle.js:167190:11)
    at processDispatchQueue (http://localhost:3000/static/js/bundle.js:167201:9)
    at dispatchEventsForPlugins (http://localhost:3000/static/js/bundle.js:167210:7)
ERROR
Cannot read properties of null (reading 'row')
TypeError: Cannot read properties of null (reading 'row')
    at handleMouseDown (http://localhost:3000/static/js/bundle.js:247508:71)
    at onMouseDown (http://localhost:3000/static/js/bundle.js:247523:29)
    at HTMLUnknownElement.callCallback (http://localhost:3000/static/js/bundle.js:162906:18)
    at Object.invokeGuardedCallbackDev (http://localhost:3000/static/js/bundle.js:162950:20)
    at invokeGuardedCallback (http://localhost:3000/static/js/bundle.js:163007:35)
    at invokeGuardedCallbackAndCatchFirstError (http://localhost:3000/static/js/bundle.js:163021:29)
    at executeDispatch (http://localhost:3000/static/js/bundle.js:167164:7)
    at processDispatchQueueItemsInOrder (http://localhost:3000/static/js/bundle.js:167190:11)
    at processDispatchQueue (http://localhost:3000/static/js/bundle.js:167201:9)
    at dispatchEventsForPlugins (http://localhost:3000/static/js/bundle.js:167210:7)
####1.2. Workbench
WorkBench inside the panel does not work
####1.3. Aggregated Editing
There is a need to apply coefficient to all channels simultaneously

###Task 2. Volume and Feedback sliders
####2.1. Set default sensitivity for volume to 6
####2.2. Apply the same sensitivity mechanism to Feedback slider

###Task 3. Fix React "Maximum update depth exceeded" warnings during preset load
Pre-existing cascade: each history object init (feedin, feedback, strings, modes, excitation, 2x sound channels) triggers 5+ state updates that cascade through useEffects (~50 renders). Guard sync useEffects against initial load (skip when currentStep <= 1). Touches 20+ useEffects in PianoidTuner.js, useMatrixHistory.js, useValuesHistory.js.