(function() {
    'use strict';

    angular
        .module('oncoscape')
        .directive('osTimelines', timelines);

    /** @ngInject */
    function timelines() {

        var directive = {
            restrict: 'E',
            templateUrl: 'app/components/timelines/timelines.html',
            controller: TimelinesController,
            controllerAs: 'vm',
            bindToController: true
        };

        return directive;

        /** @ngInject */
        function TimelinesController(osApi, osCohortService, $state, $scope, $stateParams, $window, $document, moment, d3, _) {


            // Loading . . . 
            osApi.setBusy(true);

            // View Model
            var patientsAll, patientsFiltered, patientsDomain;
            var patientsSelectedIds = [];
            var rowHeight = 20;
            var baseZoomX = 1;
            var baseZoomY = 1;
            var xZoom, yZoom, xTran, yTran;
            var scaleX;
            var vm = this;
            vm.datasource = osApi.getDataSource();
            vm.cohort = osCohortService.getCohort();
            vm.timescales = [
                { name: 'Log', valFn: function(val) { return (val < 0 ? -1 : 1) * Math.log(Math.abs((val * 1000) / 86400000) + 1) / Math.log(2); } },
                { name: 'Linear', valFn: function(val) { return moment.duration(val * 1000).asDays(); } }
            ];
            vm.filters = [
                { name: 'Alive + Dead' },
                { name: 'Only Alive' },
                { name: 'Only Dead' }
            ];
            vm.modes = [
                { name: "Highlight" },
                { name: "Filter" }
            ];
            vm.displayModes = [
                { name: 'All Patients' },
                { name: 'Selected Patients' }
            ];
            vm.timescale = vm.timescales[0];
            vm.filter = vm.filters[2];
            vm.mode = vm.modes[0];
            vm.displayMode = vm.displayModes[0];
            vm.events = null;
            vm.align = null;
            vm.sort = null;
            vm.resetZoom = function() {
                patientsSelectedIds = [];
                osCohortService.setCohort([], osCohortService.ALL, osCohortService.PATIENT);
                elScrollY.call(brushY.move, null);
                elScrollX.call(brushY.move, null);
                vm.update();
            };

            // Elements
            var brushY = d3.brushY().handleSize(3);
            var brushX = d3.brushX().handleSize(3);
            var brushSelect = d3.brushY().handleSize(1);
            var elContainer = d3.select(".timelines-content");
            var elAxis = elContainer.append("svg").attr("class", "timeline-axis");
            var elScrollY = elContainer.append("svg").attr("class", "timeline-scroll-y");
            var elScrollX = elContainer.append("svg").attr("class", "timeline-scroll-x");
            var elChart = elContainer.append("svg").attr("class", "timeline-chart");
            var elSelected = elChart.append("g");
            var elPatients = elChart.append("g");

            elContainer = angular.element(".timelines-content");

            // Utility
            vm.update = function() {
                console.log("vmupdate")
                    // Width + Height Subract 20 For Scoll Bars
                var layout = osApi.getLayout();
                var width = $window.innerWidth - layout.left - layout.right - 80;
                var height = $window.innerHeight - 250;
                console.log(width);

                updateData();
                updateSize(width, height, layout);
                updateScrollbars(width, height);
                updatePatients(width, height);
                updateZoom(width, height);
                updateAxis(width, height);
            };


            // Update Data Models
            var updateData = function() {
                // Retrieve State
                var align = vm.align.name;
                var sort = vm.sort.name;
                var filter = vm.filter.name;
                var events = vm.events.filter(function(e) {
                    return e.selected
                }).map(function(e) {
                    return e.name.toLowerCase();
                });

                // Filter Event Data
                patientsFiltered = patientsAll;

                // Filter
                patientsDomain = [Infinity, -Infinity];
                patientsFiltered.forEach(function(patient) {

                    // Filter Patients W/O Align, Sort or Filter
                    if (!patient.hash.hasOwnProperty(this.align) || !patient.hash.hasOwnProperty(this.sort) || !patient.hash.hasOwnProperty("Status")) {
                        patient.visible = false;
                    } else {

                        // Filter Alive + Dead
                        var status = patient.hash["Status"].data.status;
                        if ((this.filter == "Only Alive" && status == "Dead") || (this.filter == "Only Dead" && status != "Dead")) {
                            patient.visible = false;
                        } else {
                            if (vm.displayMode.name == "Selected Patients" && selectedIds.length > 0) {
                                patient.visible = (selectedIds.indexOf(patient.id) != -1);
                            } else {
                                patient.visible = true;
                            }
                            if (patient.visible) {
                                this.offset = 0 - patient.hash[this.align].tsStart;
                                // Filter Events
                                patient.events.forEach(function(event) {
                                    event.visible = (this.events.indexOf(event.name.toLowerCase()) != -1);
                                    // Calculate Start + End Based On Alignment
                                    if (event.visible) {
                                        event.tsStartAligned = vm.timescale.valFn(event.tsStart + this.offset);
                                        event.tsEndAligned = vm.timescale.valFn(event.tsEnd + this.offset);
                                        this.domain[0] = Math.min(this.domain[0], event.tsStartAligned);
                                        this.domain[1] = Math.max(this.domain[1], event.tsEndAligned);
                                    }
                                }, this);
                            }
                        }
                    }
                }, {
                    align: align,
                    sort: sort,
                    filter: filter,
                    events: events,
                    domain: patientsDomain,
                    offset: 0
                });

                // Remove Patients That Do Not Have Alignment Property
                patientsFiltered = patientsFiltered.filter(function(p) {
                    return p.visible;
                });

                // Set Selected
                patientsFiltered.forEach(function(v) {
                    v.selected = (patientsSelectedIds.indexOf(v.id) != -1);
                });

                // Sort Patients
                patientsFiltered = patientsFiltered.sort(function(a, b) {
                    if (a.status == b.status) {
                        var aTime = a.events.filter(function(e) { return (e.name == sort && e.order == 1) })[0].tsStartAligned;
                        var bTime = b.events.filter(function(e) { return (e.name == sort && e.order == 1) })[0].tsStartAligned;
                        if (aTime > bTime) return 1;
                        if (bTime > aTime) return -1;
                        return 0;
                    } else {
                        return (a.status == "dead") ? 1 : -1;
                    }
                });
            };
            var daysToUnit = function(d) {
                if (Math.abs(d) == 0) return d;
                if (Math.abs(d) < 30) return d + " Days";
                if (Math.abs(d) < 360) return Math.round((d / 30.4) * 10) / 10 + " Months";
                return Math.round((d / 365) * 10) / 10 + " Years";
            };
            var updateAxis = function(width, height) {
                var axis = d3.axisBottom(scaleX).ticks(7);
                if (vm.timescale.name == 'Linear') {
                    axis.tickFormat(function(d) {
                        return daysToUnit(d);
                    });
                } else {
                    axis.tickFormat(function(d) {
                        return daysToUnit(Math.round((d < 0 ? -1 : 1) * (Math.pow(2, (Math.abs(d))) - 1) * 100) / 100);
                    });
                }
                elAxis.call(axis);
            };

            // Update Size
            var updateSize = function(width, height, layout) {
                elContainer.css("background", "#FAFAFA").css("margin-left", layout.left + 30).css("margin-right", layout.right).css("width", width + 20).css("height", height + 20);
                elScrollY.attr("height", height);
                elScrollX.attr("width", width);
                elChart.attr("height", height).attr("width", width).attr("fill", "blue").attr('transform', 'translate(20,20)');
                elPatients.attr("height", height).attr("width", width);
                elAxis.style("top", height + 20).attr("width", "width");
            }

            // Update Zoom
            var updateZoom = function(width, height) {
                baseZoomY = height / (patientsFiltered.length * rowHeight);
                baseZoomX = 1;
                xZoom = baseZoomX;
                yZoom = baseZoomY;
                xTran = 0;
                yTran = 0;
                elPatients.attr("transform", "translate(" + xTran + "," + yTran + ") scale(" + xZoom + "," + yZoom + ")");
            };

            var updateScrollbars = function(width, height) {
                elScrollY.call(
                    brushY
                    .on("end", function() {
                        if (d3.event.selection !== null) {
                            var lower = d3.event.selection[0];
                            var upper = d3.event.selection[1];
                            var domain = height;
                            var lowerPercent = lower / domain;
                            var upperPercent = upper / domain;
                            var deltaPercent = upperPercent - lowerPercent;
                            yZoom = (baseZoomY / deltaPercent);
                            yTran = (rowHeight * patientsFiltered.length * yZoom) * -lowerPercent;
                        } else {
                            if (yZoom == baseZoomY && yTran == 0) return;
                            yZoom = baseZoomY;
                            yTran = 0;
                            elScrollY.call(brushY.move, null);
                        }
                        elPatients
                            .transition()
                            .duration(750)
                            .attr("transform", "translate(" + xTran + "," + yTran + ") scale(" + xZoom + "," + yZoom + ")");
                    })
                );
                elScrollX.call(
                    brushX
                    .on("end", function() {
                        if (d3.event.selection !== null) {
                            var lower = d3.event.selection[0];
                            var upper = d3.event.selection[1];
                            var domain = width - 20;
                            var lowerPercent = lower / domain;
                            var upperPercent = upper / domain;
                            var deltaPercent = upperPercent - lowerPercent;
                            xZoom = (baseZoomX / deltaPercent);
                            xTran = (width * xZoom) * -lowerPercent;
                        } else {
                            if (xZoom == baseZoomX && xTran == 0) return;
                            xZoom = baseZoomX;
                            xTran = 0;
                            elScrollX.call(brushX.move, null);

                        }
                        elPatients
                            .transition()
                            .duration(750)
                            .attr("transform", "translate(" + xTran + "," + yTran + ") scale(" + xZoom + "," + yZoom + ")");

                    })
                );
            };

            // Update Patients
            var updateEvents = function(evts) {
                evts.exit().remove();
                evts.enter().append("rect")
                    .attr('class', 'event')
                    .attr('width', function(d) { return Math.max((scaleX(d.tsEndAligned) - scaleX(d.tsStartAligned)), 2); })
                    .attr('height', function(d) { return (d.name == "Radiation" || d.name == "Drug") ? rowHeight / 2 : rowHeight; })
                    .attr('y', function(d) { return ((d.name == "Radiation") ? rowHeight / 2 : 0); })
                    .attr('x', function(d) { return scaleX(d.tsStartAligned); })
                    .style('fill', function(d) { return d.color; })
                evts
                    .attr('width', function(d) { return Math.max((scaleX(d.tsEndAligned) - scaleX(d.tsStartAligned)), 2); })
                    .attr('height', function(d) { return (d.name == "Radiation" || d.name == "Drug") ? rowHeight / 2 : rowHeight; })
                    .attr('y', function(d) { return ((d.name == "Radiation") ? rowHeight / 2 : 0); })
                    .attr('x', function(d) { return scaleX(d.tsStartAligned); })
                    .style('fill', function(d) { return d.color; })
            }
            var updatePatients = function(width) {

                // Set Scale
                scaleX = d3.scaleLinear().domain(patientsDomain).range([0, width]).nice();
                var patients = elPatients.selectAll("g.patient").data(patientsFiltered);
                patients.exit()
                    .transition()
                    .delay(200)
                    .duration(500)
                    .style('opacity', 0.0)
                    .remove();

                var patientEnter = patients.enter()
                    .append('g')
                    .attr("class", "patient")
                    .attr('transform', function(d, i) {
                        return "translate(0," + (i * rowHeight) + ")";
                    });

                updateEvents(patients.selectAll(".event").data(function(d) {
                    return d.events.filter(function(v) { return v.visible; });
                }));



                updateEvents(patientEnter.selectAll(".event").data(function(d) {
                    return d.events.filter(function(v) { return v.visible; });
                }));

            };


            // Application Events
            var onCohortChange = function(c) { vm.cohort = c; };
            osCohortService.onCohortChange.add(onCohortChange);

            // Load + Format Data
            osApi.query(osApi.getDataSource().clinical.events, {}).then(function(response) {
                var colorFn = function(status) {
                    return (status == "Birth") ? "#E91E63" :
                        (status == "Diagnosis") ? "#673AB7" :
                        (status == "Pathology") ? "#2196F3" :
                        (status == "Progression") ? "#00BCD4" :
                        (status == "Absent") ? "#CDDC39" :
                        (status == "Status") ? "#FFC107" :
                        (status == "Radiation") ? "#FF5722" :
                        (status == "Procedure") ? "#795548" :
                        (status == "Encounter") ? "#607D8B" :
                        (status == "Drug") ? "#03A9F4" :
                        "black";
                };
                var data = response.data[0];
                var events = {};
                data = Object.keys(data).map(function(key) {
                    // Loop Throug Events
                    var evtArray = this.data[key]
                        .filter(function(v) {
                            return v.start != null;
                        })
                        .map(function(v) {
                            this.events[v.name] = null;
                            v.tsStart = moment(v.start, "MM/DD/YYYY").unix();
                            v.tsEnd = (v.end == null) ? v.tsStart : moment(v.end, "MM/DD/YYYY").unix();
                            v.tsStartAligned = "";
                            v.tsEndAligned = "";
                            v.end = (v.end == null) ? v.start : v.end;
                            v.color = this.colorFn(v.name);
                            v.visible = true;
                            v.order = 1;
                            return v;
                        }, {
                            events: this.events,
                            colorFn: this.colorFn
                        });
                    var evtHash = evtArray.reduce(function(p, c) {
                        if (p.hasOwnProperty(c.name)) {
                            if (p[c.name].tsStart > c.tsStart) p[c.name] = c;
                        } else {
                            p[c.name] = c;
                        }
                        return p;
                    }, {});
                    return {
                        id: key,
                        events: evtArray,
                        hash: evtHash
                    };
                }, {
                    data: data,
                    events: events,
                    colorFn: colorFn
                });
                data.forEach(function(patient) {
                    var groups = _.groupBy(patient.events, 'name');
                    var keys = Object.keys(groups).filter(function(prop) {
                        return (this[prop].length > 1);
                    }, groups);
                    keys.forEach(function(v) {
                        var i = 1;
                        patient.events
                            .filter(function(e) { return e.name == v; })
                            .sort(function(a, b) {
                                return a.tsStart - b.tsStart;
                            }).forEach(function(v) {
                                v.order = i;
                                i++;
                            });
                    });
                });
                patientsAll = data.filter(function(v) {
                    try {
                        v.status = v.hash["Status"].data.status.toLowerCase();
                        return true;
                    } catch (e) {
                        return false;
                    }
                    return false;
                });
                vm.events = Object.keys(events).map(function(v) {
                    return {
                        name: v,
                        selected: (["Birth", "Pathology", "Absent", "Procedure"].indexOf(v) == -1),
                        color: this(v)
                    };
                }, colorFn);
                vm.align = vm.events.filter(function(v) {
                    if (v.name == "Diagnosis") return true;
                })[0];
                vm.sort = vm.events.filter(function(v) {
                    if (v.name == "Status") return true;
                })[0];
                vm.update();
                osApi.setBusy(false);
            });

            // Resize Events
            osApi.onResize.add(vm.update);

            function resize() { _.debounce(vm.update, 300); }
            angular.element($window).bind('resize', resize);


            // Destroy
            $scope.$on('$destroy', function() {
                osCohortService.onCohortChange.add(onCohortChange);
                osApi.onResize.remove(vm.update);
                angular.element($window).unbind('resize', resize);
            });
        }
    }
})();