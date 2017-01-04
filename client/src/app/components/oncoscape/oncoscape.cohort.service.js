(function() {
    'use strict';

    angular
        .module('oncoscape')
        .service('osCohortService', osCohortService);

    /** @ngInject */
    function osCohortService(osApi, moment, signals, $q, jStat, _, localStorage) {

        // There are three types of cohorts: ALL = All users, SAVED: Saved, UNSAVED

        // Messages
        var onCohortChange = new signals.Signal();
        var onCohortsChange = new signals.Signal();
        var onPatientColorChange = new signals.Signal();

        // Patient Color
        var _patientColor;
        var getPatientColor = function() { return _patientColor; };
        var setPatientColor = function(patientColor) {
            _patientColor = patientColor;
            onPatientColorChange.dispatch(patientColor);
        };

        // State Variables
        var _dataSource = null;
        var _data = null; // This is the clinical and sample to patient mapping data. 
        var _cohorts = null; // Collection of Cohorts
        var _cohort = null;

        // Accessors
        var getCohorts = function() { return _cohorts; };
        var getCohort = function() { return _cohort; };
        var getData = function() { return _data; };

        // Stats Factory
        var statsFactory = (function(jStat) {

            var km = (function(jStat) {

                var pluck,
                    uniq,
                    sortBy,
                    groupBy,
                    last,
                    find;

                function multiply(a, b) {
                    var r = jStat.multiply(a, b);
                    return r.length ? r : [
                        [r]
                    ];
                }

                function transpose(a) {
                    var r = jStat.transpose(a);
                    return r[0].length ? r : [r];
                }

                function timeTable(tte, ev) {
                    var exits = sortBy(tte.map((x, i) => ({ tte: x, ev: ev[i] })), 'tte'), // sort and collate
                        uexits = uniq(pluck(exits, 'tte'), true), // unique tte
                        gexits = groupBy(exits, x => x.tte); // group by common time of exit
                    return uexits.reduce(function(a, tte) { // compute d_i, n_i for times t_i (including censor times)
                        var group = gexits[tte],
                            l = last(a) || { n: exits.length, e: 0 },
                            events = group.filter(x => x.ev);

                        a.push({
                            n: l.n - l.e, // at risk
                            e: group.length, // number exiting
                            d: events.length, // number events (death)
                            t: group[0].tte // time
                        });
                        return a;
                    }, []);
                }

                function compute(tte, ev) {
                    var dini = timeTable(tte, ev);
                    return dini.reduce(function(a, dn) { // survival at each t_i (including censor times)
                        var l = last(a) || { s: 1 };
                        if (dn.d) { // there were events at this t_i
                            a.push({ t: dn.t, e: true, s: l.s * (1 - dn.d / dn.n), n: dn.n, d: dn.d, rate: dn.d / dn.n });
                        } else { // only censors
                            a.push({ t: dn.t, e: false, s: l.s, n: dn.n, d: dn.d, rate: null });
                        }
                        return a;
                    }, []);
                }

                function expectedObservedEventNumber(si, tte, ev) {
                    var data = timeTable(tte, ev),
                        expectedNumber,
                        observedNumber,
                        dataByTimeTable = [];

                    si = si.filter(item => item.e);

                    expectedNumber = si.reduce(function(memo, item) {
                        var pointerInData = find(data, x => x.t >= item.t);

                        if (pointerInData) {
                            var expected = pointerInData.n * item.rate;
                            dataByTimeTable.push(pointerInData);
                            return memo + expected;
                        } else {
                            return memo;
                        }

                    }, 0);

                    observedNumber = ev.filter(x => x).length;

                    return {
                        expected: expectedNumber,
                        observed: observedNumber,
                        dataByTimeTable: dataByTimeTable,
                        timeNumber: dataByTimeTable.length
                    };
                }

                function covariance(allGroupsRes, OETable) {
                    var vv = jStat.zeros(OETable.length),
                        i, j, //groups
                        t, //timeIndex
                        N, //total number of samples
                        Ki, Kj, // at risk number from each group
                        n; //total observed

                    for (i = 0; i < OETable.length; i++) {
                        for (j = i; j < OETable.length; j++) {
                            for (t = 0; t < allGroupsRes.length; t++) {
                                N = allGroupsRes[t].n;
                                n = allGroupsRes[t].d;
                                if (t < OETable[i].timeNumber && t < OETable[j].timeNumber) {
                                    Ki = OETable[i].dataByTimeTable[t].n;
                                    Kj = OETable[j].dataByTimeTable[t].n;
                                    // when N==1: only 1 subject, no variance
                                    if (i !== j && N !== 1) {
                                        vv[i][j] -= n * Ki * Kj * (N - n) / (N * N * (N - 1));
                                        vv[j][i] = vv[i][j];
                                    } else if (N !== 1) { // i==j
                                        vv[i][i] += n * Ki * (N - Ki) * (N - n) / (N * N * (N - 1));
                                    }
                                }
                            }
                        }
                    }
                    return vv;
                }

                // This might be the mis-named.
                function solve(a, b) {
                    var bT = transpose(b),
                        aInv = jStat.inv(a);
                    return multiply(multiply(b, aInv), bT);
                }

                function allGroupsKm(groups) {
                    var tte = [].concat.apply([], pluck(groups, 'tte')),
                        ev = [].concat.apply([], pluck(groups, 'ev'));
                    return compute(tte, ev).filter(t => t.e);
                }

                // allGroupsRes: km of all groups combined?
                // groupedDataTable: [{tte, ev}, ...]
                function logranktest(groupedDataTable) {
                    var allGroupsRes = allGroupsKm(groupedDataTable),
                        pValue = 1,
                        KMStats,
                        dof, // degree of freedom
                        OETable,
                        OMinusEVector, // O-E
                        vv; //covariant matrix

                    // Table of observed and expected events, for each group.
                    OETable = groupedDataTable
                        .map(({ tte, ev }) => expectedObservedEventNumber(allGroupsRes, tte, ev))
                        .filter(r => r.expected);

                    // Find O-E and covariance, and drop one dimension from each
                    OMinusEVector = OETable.map(r => r.observed - r.expected).slice(1);
                    vv = covariance(allGroupsRes, OETable).slice(1).map(r => r.slice(1)); // drop 1st row & 1st column

                    dof = OETable.length - 1;

                    if (dof > 0) {
                        KMStats = solve(vv, [OMinusEVector])[0][0];
                        pValue = 1 - jStat.chisquare.cdf(KMStats, dof);
                    }

                    return {
                        dof: dof,
                        KMStats: KMStats,
                        pValue: pValue
                    };
                }

                var exports = {
                    init: obj => {
                        pluck = obj.pluck;
                        uniq = obj.uniq;
                        sortBy = obj.sortBy;
                        groupBy = obj.groupBy;
                        last = obj.last;
                        find = obj.find;
                        return exports; // return the module for convenience of the caller
                    },
                    compute: compute,
                    expectedObservedEventNumber: expectedObservedEventNumber,
                    logranktest: logranktest
                };
                return exports;
            })(jStat).init(_);

            function getNumericStats(patients, attribute) {
                var len = patients.length;
                var bin =
                    (len < 2) ? 1 :
                    (len < 6) ? 2 :
                    (len < 9) ? 3 :
                    (len < 18) ? 6 :
                    (len < 36) ? 8 :
                    10;

                var props = patients.map(function(pd) {
                    return pd[attribute];
                });

                var data = {
                    type: "numeric",
                    min: jStat.min(props),
                    max: jStat.max(props),
                    range: jStat.range(props),
                    sd: jStat.stdev(props),
                    count: 0,
                    hist: jStat.histogram(props, bin),
                    histRange: [],
                    bins: bin
                };

                data.histRange = [jStat.min(data.hist), jStat.max(data.hist)];
                data.count = data.hist.reduce(function(p, c) { p += c; return p; }, 0);

                bin = Math.round(data.range / bin);
                data.hist = data.hist.map(function(pt) {
                    var rv = {
                        label: this.start + "-" + (this.start + this.bin),
                        value: pt
                    };
                    this.start += this.bin;
                    return rv;
                }, {
                    bin: bin,
                    start: data.min
                });
                return data;
            }

            function getFactorStats(patients, attribute) {

                var props = patients.map(function(pd) {
                    return pd[attribute];
                });
                var factors = props
                    .reduce(function(prev, curr) {
                        prev[curr] = (prev.hasOwnProperty(curr)) ? prev[curr] + 1 : 1;
                        return prev;
                    }, {});

                factors = Object.keys(factors).map(function(key) {
                    return {
                        label: key,
                        value: this.factors[key]
                    };
                }, {
                    factors: factors
                });

                var values = factors.map(function(v) {
                    return v.value;
                });
                var data = {
                    type: "factor",
                    min: jStat.min(values),
                    max: jStat.max(values),
                    range: jStat.range(values),
                    sd: jStat.stdev(values),
                    count: 0,
                    hist: factors,
                    histRange: [],
                    bins: factors.length
                };
                data.histRange = [data.min, data.max];
                data.count = data.hist.reduce(function(p, c) { p += c.value; return p; }, 0);
                return data;
            }

            var createHistogram = function(ids, data) {

                // Transform Ids Into Clinical Records + Remove Nulls
                var clinical = ids.map(function(v) {
                    var patient = this[v];
                    if (patient === null) return null;
                    return patient.clinical;
                }, data.patientMap).filter(function(v) { return v != null; })

                return {
                    total: Object.keys(data.patientMap).length,
                    selected: clinical.length,
                    features: [{
                            label: "Age At Diagnosis",
                            data: getNumericStats(clinical, "age_at_diagnosis"),
                            prop: "age_at_diagnosis",
                            type: "numeric"
                        },
                        //{label: "Death", data:getNumericStats(data,"days_to_death"), prop:"days_to_death" , type:"numeric"},
                        {
                            label: "Gender",
                            data: getFactorStats(clinical, "gender"),
                            prop: "gender",
                            type: "factor"
                        }, {
                            label: "Race",
                            data: getFactorStats(clinical, "race"),
                            prop: "race",
                            type: "factor"
                        }, {
                            label: "Ethnicity",
                            data: getFactorStats(clinical, "ethnicity"),
                            prop: "ethnicity",
                            type: "factor"
                        }, {
                            label: "Vital",
                            data: getFactorStats(clinical, "status_vital"),
                            prop: "status_vital",
                            type: "factor"
                        }, {
                            label: "Disease Status",
                            data: getFactorStats(clinical, "last_known_disease_status"),
                            prop: "last_known_disease_status",
                            type: "factor"
                        }
                    ]
                };
            };

            var createSurvival = function(ids, data, cohortAll) {

                // Transform Ids Into Survival Records + Remove Nulls
                var survival = ids.map(function(v) {
                        var patient = this[v];
                        if (patient === null) return null;
                        return patient.survival;
                    }, data.patientMap)
                    .filter(function(v) { return angular.isDefined(v); });

                /* Transform Survival Records Into KM Data The Result Is A Value Object Containing The Following
                    t = time in days
                    c = array of censored patient ids
                    d = array of dead patient ids
                    n = numer of patients remaining
                    s = survival rate
                    p = previous survival rate 
                    */
                var te = survival.reduce(function(p, c) {
                    p.tte.push(c.tte);
                    p.ev.push(c.ev);
                    return p;
                }, { tte: [], ev: [] });
                var vo = km.compute(te.tte, te.ev)
                    .map(r => _.omit(r, ['rate', 'e']));
                vo.forEach(function(c, i, a) {

                    // Add Previous Survival Rate
                    c.s *= 100;
                    c.p = this.survivalPrevious;
                    this.survivalPrevious = c.s;

                    // Add IDS Back To Times
                    var cd = this.survival.reduce(function(p, c) {

                        if (p.time == c.tte) {
                            p[c.ev ? "dead" : "censor"].push(c.pid);
                        }
                        return p;
                    }, { censor: [], dead: [], time: c.t });

                    c.c = cd.censor;
                    c.d = cd.dead;
                    return c;
                }, { length: vo.length - 1, survival: survival, survivalPrevious: 100 });

                /* Description of VO
                    t = time in days
                    c = array of censored patient ids
                    d = array of dead patient ids
                    n = numer of patients remaining
                    s = survival rate
                    p = previous survival rate 
                */

                // Convert Result To Ticks + Lines + Calc Stats
                var rv = vo.reduce(function(p, c) {
                    var numCensored = c.c.length;
                    var numDead = c.d.length;
                    var obj = { alive: c.c, dead: c.d, survivalFrom: c.p, survivalTo: c.s, time: c.t };
                    if (numCensored > 0) {
                        p.data.ticks.push(obj);
                        p.alive += numCensored;
                    }
                    if (numDead > 0) {
                        p.data.lines.push({ alive: c.c, dead: c.d, survivalFrom: c.p, survivalTo: c.s, time: c.t });
                        p.dead += numDead;
                    }
                    p.total += numCensored + numDead;
                    p.min = Math.min(p.min, c.t);
                    p.max = Math.max(p.max, c.t);
                    return p;
                }, { data: { ticks: [], lines: [] }, total: 0, alive: 0, dead: 0, min: Infinity, max: -Infinity });
                rv.te = te;
                rv.logrank = (cohortAll == null) ? null : km.logranktest([rv.te, cohortAll.survival.te]);
                return rv;

            };

            return {
                km: km,
                createHistogram: createHistogram,
                createSurvival: createSurvival
            };
        })(jStat);

        // Cohort Factory
        var cohortFactory = (function(osApi, statsFactory) {

            var _data = null;
            var cohortAll = null;

            // Set Data Create Internal Reference + Also Calc's Cohort All Group
            var setData = function(data) {

                _data = data;
                cohortAll = {
                    color: '#0b97d3',
                    patientIds: [],
                    sampleIds: [],
                    name: 'All Patients + Samples',
                    histogram: statsFactory.createHistogram(Object.keys(data.patientMap), data),
                    survival: statsFactory.createSurvival(Object.keys(data.patientMap), data, null),
                    numPatients: Object.keys(_data.patientMap).length,
                    numSamples: Object.keys(_data.sampleMap).length,
                    numClinical: Object.keys(_data.patientMap).reduce(function(p, c) { p += (_data.patientMap[c].hasOwnProperty('clinical')) ? 1 : 0; return p; }, 0),
                    show: true,
                    type: 'ALL'
                };
            };

            var createWithSampleIds = function(name, sampleIds, data) {

                if (sampleIds.length === 0) return cohortAll;
                var patientIds = sampleIds
                    .map(function(v) { return this.hasOwnProperty(v) ? this[v] : null; }, data.sampleMap)
                    .filter(function(v) { return (v !== null); }) // Remove Null
                    .filter(function(item, i, ar) { return ar.indexOf(item) === i; }); // Remove Dups

                return create(name, patientIds, sampleIds);
            };

            var createWithPatientIds = function(name, patientIds, data) {

                if (patientIds.length === 0) return cohortAll;
                var sampleIds = [].concat
                    .apply([], patientIds
                        .map(function(v) { return this.hasOwnProperty(v) ? this[v].samples : null; }, data.patientMap))
                    .filter(function(item, i, ar) { return ar.indexOf(item) === i; });

                return create(name, patientIds, sampleIds);
            };

            var create = function(name, patientIds, sampleIds) {
                var rv = {
                    uuid: Math.random().toString().substr(2),
                    color: '#000',
                    patientIds: patientIds,
                    sampleIds: sampleIds,
                    name: name,
                    histogram: statsFactory.createHistogram(patientIds, _data),
                    survival: statsFactory.createSurvival(patientIds, _data, cohortAll),
                    numPatients: patientIds.length,
                    numSamples: sampleIds.length,
                    numClinical: patientIds.reduce(function(p, c) { p += (_data.patientMap[c].hasOwnProperty('clinical')) ? 1 : 0; return p; }, 0),
                    show: true,
                    type: 'UNSAVED'
                };
                return rv;
            };

            return {
                setData: setData,
                createWithSampleIds: createWithSampleIds,
                createWithPatientIds: createWithPatientIds
            };

        })(osApi, statsFactory, _data);

        var colors = ["#E91E63", "#673AB7", "#4CAF50", "#CDDC39", "#FFC107", "#FF5722", "#795548", "#607D8B", "#03A9F4", "#03A9F4", '#004358', '#800080', '#BEDB39', '#FD7400', '#1F8A70', '#B71C1C', '#880E4F', '#4A148C', '#311B92', '#0D47A1', '#006064', '#1B5E20'];
        var setCohort = function(cohort, name, type) {
            // Create Cohort If Array Passed
            if (angular.isArray(cohort)) {
                name += "  (" + moment().format('hh:mm:ss') + ")";
                cohort = cohortFactory[(type == "PATIENT") ? "createWithPatientIds" : "createWithSampleIds"](name, cohort, _data);
                cohort.type = (cohort.patientIds.length === 0) ? "ALL" : "UNSAVED";
                if (cohort.type != "ALL") {
                    var usedColors = _cohorts.map(function(v) { return v.color; });
                    var availColors = colors.filter(function(v) { return (usedColors.indexOf(v) == -1); });
                    cohort.color = availColors[0];
                }
            }
            _cohort = cohort;
            onCohortChange.dispatch(_cohort);
        };

        // Loads Data Nessisary To Map Patients + Samples + Clinical Data To Derive Stats
        var loadData = function() {
            return new Promise(function(resolve) {
                if (_data !== null) resolve(_data);
                _dataSource = osApi.getDataSource();
                $q.all([
                    osApi.query(_dataSource.clinical.samplemap),
                    osApi.query(_dataSource.clinical.patient)
                ]).then(function(responses) {
                    var data = {};

                    // Map of Samples To Patients
                    data.sampleMap = responses[0].data[0];

                    // Map of Patients To Samples + Clinical Using Samples Ids
                    data.patientMap = Object.keys(data.sampleMap).reduce(function(p, c) {
                        var patient = data.sampleMap[c];
                        var sample = c;
                        if (p.hasOwnProperty(patient)) {
                            p[patient].samples.push(sample);
                        } else {
                            p[patient] = { samples: [sample] };
                        }
                        return p;
                    }, {});
                    responses[1].data.reduce(function(p, c) {
                        if (p.hasOwnProperty(c.patient_ID)) {
                            p[c.patient_ID].clinical = c;
                        } else {
                            p[c.patient_ID] = { clinical: c, samples: [] };
                        }
                        return p;
                    }, data.patientMap);

                    // Survival Data 
                    responses[1].data.map(function(v) {

                        // No Status - Exclude
                        if (!v.hasOwnProperty("status_vital")) return null;
                        if (v.status_vital === null) return null;

                        // Get Time - Or Exclude    
                        var status = v.status_vital.toString().trim().toUpperCase();
                        var time;
                        if (status == "ALIVE") { // Alive = Sensor 2
                            if (!v.hasOwnProperty("days_to_last_follow_up")) return null;
                            time = parseInt(v.days_to_last_follow_up);
                            if (time < 0) time = 0;
                            if (isNaN(time)) return null;
                            return { pid: v.patient_ID, ev: false, tte: time };
                        }
                        if (status == "DEAD") { // Dead = Sensor 1
                            if (!v.hasOwnProperty("days_to_death")) return null;
                            time = parseInt(v.days_to_death);
                            if (time < 0) time = 0;
                            if (isNaN(time)) return null;
                            return { pid: v.patient_ID, ev: true, tte: time };
                        }
                        return null;
                    }).reduce(function(p, c) {
                        if (c !== null) {
                            p[c.pid].survival = c;
                        }
                        return p;
                    }, data.patientMap);
                    cohortFactory.setData(data);
                    _data = data;
                    resolve(_data);
                });
            });
        };

        var loadCohorts = function() {
            return new Promise(function(resolve) {
                loadData().then(function() {

                    // Try + Pull From Local Storage
                    _cohorts = localStorage.getItem(osApi.getDataSource().disease + 'Cohorts');

                    // If Successful Set Selected + Resolve
                    if (_cohorts !== null) {
                        _cohorts = angular.fromJson(_cohorts);
                        _cohort = _cohorts[0];
                    } else {
                        _cohorts = [cohortFactory.createWithPatientIds("ALL", [], _data)];
                        _cohort = _cohorts[0];
                        _cohort.type = "ALL";
                    }

                    onCohortsChange.dispatch(_cohorts);
                    onCohortChange.dispatch(_cohort);
                    resolve(_cohorts);
                });
            });
        };

        var saveCohort = function() {
            _cohort.type = "SAVED";
            _cohorts.push(_cohort);
            localStorage.setItem(osApi.getDataSource().disease + 'Cohorts', angular.toJson(_cohorts));

        };
        var deleteCohort = function(cohort) {
            _cohorts.splice(_cohorts.indexOf(cohort), 1);
            localStorage.setItem(osApi.getDataSource().disease + 'Cohorts', angular.toJson(_cohorts));
            setCohort([], "", "PATIENT");
        };

        // Converts Sample Ids To A List of Sample Ids
        var importIds = function(ids, name) {
            var sampleIds = _.union.apply(null, ids
                .map(function(id) { // Convert All Ids to Patient Ids
                    id = id.toUpperCase().trim(); // Clean input
                    return _data.sampleMap.hasOwnProperty(id) ? _data.sampleMap[id] : id;
                })
                .filter(function(id) { // Remove Invalid Patient Ids
                    return _data.patientMap.hasOwnProperty(id);
                })
                .map(function(id) { // Convert Patient Ids To Sample Arrays
                    return _data.patientMap[id].samples;
                })); // Union Merges Arrays + Removes Dups

            setCohort(sampleIds, name, "SAMPLE");
            saveCohort();
        }


        var api = {
            ALL: "All Patients",
            SAMPLE: "SAMPLE",
            PATIENT: "PATIENT",

            km: statsFactory.km,

            onPatientColorChange: onPatientColorChange,
            setPatientColor: setPatientColor,
            getPatientColor: getPatientColor,

            onCohortChange: onCohortChange,
            onCohortsChange: onCohortsChange,

            importIds: importIds,
            loadCohorts: loadCohorts,
            getData: getData,
            getCohorts: getCohorts,
            getCohort: getCohort,
            setCohort: setCohort,
            saveCohort: saveCohort,
            deleteCohort: deleteCohort
        };

        return api;
    }
})();