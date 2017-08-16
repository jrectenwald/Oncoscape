(function() {
    'use strict';

    angular
        .module('oncoscape')
        .directive('osGeneMenu', geneMenu);

    /** @ngInject */
    function geneMenu() {

        var directive = {
            restrict: 'E',
            templateUrl: 'app/components/genemenu/genemenu.html',
            controller: GeneMenuController,
            controllerAs: 'vm',
            scope: {},
            bindToController: true
        };

        return directive;

        /** @ngInject */
        function GeneMenuController(osApi, $state, $scope, $sce, $timeout, $rootScope, $filter, d3) {


            // View Model
            var vm = this;
            vm.genes = [];
            vm.gene = null;
            vm.geneFeatures = [];
            vm.geneFeature = null;
            vm.geneSummary = "";

            // Gene Service Integration
            osApi.onGenesetsChange.add(function(genes) {
                vm.genes = genes;
             //   updateSurvival(genes);
            });
            osApi.onGenesetChange.add(function(gene) {

                var dataInfo = osApi.getGenesetDatasetInfo();
                var summary = "###Place Holder"
                    // $filter('number')(dataInfo.numSamples) + " Samples In Dataset<br /> " +
                    // $filter('number')(dataInfo.numPatients) + " Patients In Dataset<br /> " +
                    // $filter('number')(gene.numSamples) + " Samples In Current Gene<br /> " +
                    // $filter('number')(gene.numPatients) + " Patients In Current Gene<br />" +
                    // $filter('number')(gene.numClinical) + " Patients with Clinical Data<br />" +
                    // $filter('number')(gene.survival.data.tte.length) + " Patients with Survival Outcome<br />";
                //$filter('number')(toolInfo.numSamplesVisible) + " Samples In Current Gene Showing<br />" +
                //$filter('number')(toolInfo.numPatients) + " Patients In Current Gene Showing<br />";

                vm.geneSummary = $sce.trustAsHtml(summary);

                if (angular.isUndefined(gene)) return;
                $timeout(function() {
                    var featureIdx = (vm.geneFeature !== null) ? vm.geneFeatures.indexOf(vm.geneFeature) : 0;
                    vm.gene = gene;
                    // vm.geneFeatures = gene.histogram.features;
                    // vm.geneFeature = gene.histogram.features[featureIdx];
                });
             //   updateSurvival(vm.genes.concat([gene]));
            });

            // Gene edit
            vm.setGeneset = function(geneset) {
                if (angular.isString(geneset)) {
                    osApi.setGeneset([], osApi.ALL, osApi.SAMPLE);
                } else {
                    osApi.setGeneset(geneset);
                }
            };

            vm.updateGeneset = function() {
                if (vm.geneset.type == "UNSAVED") {
                    osApi.saveGeneset(vm.gene);
                } else {
                    osApi.deleteGeneset(vm.gene);
                }
            };

            // Tray Expand / Collapse
            var elTray = angular.element(".gene-menu");
            var isLocked = true;
            var mouseOver = function() { elTray.removeClass("tray-collapsed-left"); };
            var mouseOut = function() { elTray.addClass("tray-collapsed-left"); };
            vm.toggle = function() {
                isLocked = !isLocked;
                angular.element("#genemenu-lock")
                    .addClass(isLocked ? 'fa-lock' : 'fa-unlock-alt')
                    .removeClass(isLocked ? 'fa-unlock-alt' : 'fa-lock')
                    .attr("locked", isLocked ? "true" : "false");
                if (isLocked) {
                    elTray
                        .unbind("mouseover", mouseOver)
                        .unbind("mouseout", mouseOut)
                        .removeClass("tray-collapsed-left");
                } else {
                    elTray
                        .addClass("tray-collapsed-left")
                        .bind("mouseover", mouseOver)
                        .bind("mouseout", mouseOut);
                }
                osApi.onResize.dispatch();
            };

            // Histogram 
            var histSvg = d3.select("#genemenu-chart").append("svg")
                .attr("width", 260)
                .attr("height", 150)
                .append("g");
            var histSingleValueLabel = angular.element("#genemenu-single-value");
            var elTip = d3.tip().attr("class", "tip").offset([-8, 0]).html(function(d) {
                return "Range: " + d.label + "<br>Count: " + d.value + " of " + vm.geneFeature.data.count + "<br>Percent: " + $filter('number')((d.value / vm.geneFeature.data.count) * 100, 2) + "%";
            });
            histSvg.call(elTip);
            $scope.$watch('vm.genesetFeature', function() {

                // Histogram
                if (vm.geneFeature === null) return;
                var data = vm.geneFeature.data;
                if (data.type == "factor") {
                    if (data.hist.length == 1) {
                        histSingleValueLabel.text(data.hist[0].label).css("display", "block").removeClass("genemenu-single-value-numeric");
                        histSvg.classed("gene-chart-hide", true);
                        return;
                    }
                } else {
                    if (data.min == data.max) {
                        histSingleValueLabel.text(data.min).css("display", "block").addClass("genemenu-single-value-numeric");
                        histSvg.classed("gene-chart-hide", true);
                        return;
                    }
                }
                histSingleValueLabel.text('').css("display", "none");
                histSvg.classed("gene-chart-hide", false);
                var barWidth = Math.floor((250 - data.bins) / data.bins);


                if (data.histRange[0] > 0) data.histRange[0] -= 2;
                var yScale = d3.scaleLinear()
                    .domain([0, data.histRange[1]])
                    .range([0, 135]);
                var bars = histSvg
                    .selectAll(".gene-menu-chart-bar")
                    .data(data.hist);
                bars.enter()
                    .append("rect")
                    .attr("class", "gene-menu-chart-bar")
                    .attr("x", function(d, i) { return ((barWidth + 1) * i) + 5; })
                    .attr("y", function(d) { return 150 - yScale(d.value); })
                    .attr("height", function(d) { return yScale(d.value); })
                    .attr("width", barWidth)
                    .on("mouseover", elTip.show)
                    .on("mouseout", elTip.hide);
                bars
                    .transition()
                    .duration(300)
                    .attr("x", function(d, i) { return ((barWidth + 1) * i) + 5; })
                    .attr("y", function(d) { return 150 - yScale(d.value); })
                    .attr("height", function(d) { return yScale(d.value); })
                    .attr("width", barWidth);
                bars.exit()
                    .transition()
                    .duration(300)
                    .attr("y", 150)
                    .attr("height", 0)
                    .style('fill-opacity', 1e-6)
                    .remove();
                var labels = histSvg
                    .selectAll("text")
                    .data(data.hist);
                labels.enter()
                    .append("text")
                    .attr("x", function(d, i) { return ((4 + (barWidth + 1) * i) + (barWidth * 0.5)) + 1; })
                    .attr("y", function(d) { return 145 - yScale(d.value); })
                    .attr("fill", "#000")
                    .attr("height", function(d) { return yScale(d.value); })
                    .attr("width", barWidth)
                    .attr("font-size", "8px")
                    .attr("text-anchor", "middle")
                    .text(function(d) { return d.label; });
                labels
                    .transition()
                    .duration(300)
                    .attr("x", function(d, i) { return (((barWidth + 1) * i) + (barWidth * 0.5)) + 5; })
                    .attr("y", function(d) {
                        var y = 145 - yScale(d.value);
                        if (y < 0) y = 20;
                        return y;
                    })
                    .text(function(d) { return d.label; });
                labels.exit()
                    .transition()
                    .duration(300)
                    .attr("y", 150)
                    .attr("height", 0)
                    .style('fill-opacity', 1e-6)
                    .remove();

            });


            var formatDays = function(d) {
                if (Math.abs(d) === 0) return d;
                if (Math.abs(d) < 30) return d + " Days";
                if (Math.abs(d) < 360) return Math.round((d / 30.4) * 10) / 10 + " Mos";
                return Math.round((d / 365) * 10) / 10 + " Yrs";
            };



            // Survival
            var surSvg = d3.select("#genemenu-survival").append("svg");
            var surLines = surSvg.append("g")
                .selectAll("genemenu-survival-percent-line")
                .data([0.25, 0.5, 0.75]);

            surLines.enter()
                .append("line").attr("class", "genemenu-survival-percent-line")
                .attr("stroke-width", 1)
                .attr("stroke", "#EAEAEA")
                .attr("x1", 0).attr("x2", 250).attr("y1", function(d) {
                    return (d * 140);
                }).attr("y2", function(d) {
                    return (d * 140);
                });

            var surXAxis = surSvg.append("g").attr("class", "axisGene");
            var surLayout = {
                width: 250,
                height: 170,
                xScale: null,
                yScale: null,
                xAxis: d3.axisBottom().ticks(4).tickFormat(formatDays)
            };
            surSvg.attr("width", '100%').attr("height", surLayout.height);

            var updateSurvival = function(genes) {

                var xDomain = genes.reduce(function(p, c) {
                    p[0] = Math.min(p[0], c.survival.compute[0].t);
                    p[1] = Math.max(p[1], c.survival.compute[c.survival.compute.length - 1].t);
                    return p;
                }, [Infinity, -Infinity]);

                surLayout.xScale = d3.scaleLinear()
                    .domain(xDomain)
                    .range([0, surLayout.width - 1]);

                surLayout.yScale = d3.scaleLinear()
                    .domain([0, 1])
                    .range([surLayout.height - 30, 0]);

                var lineFunction = d3.line()
                    .curve(d3.curveStepBefore)
                    .x(function(d) { return Math.round(surLayout.xScale(d.t)); })
                    .y(function(d) { return Math.round(surLayout.yScale(d.s)); });

                surLayout.xAxis.scale(surLayout.xScale);
                surXAxis.attr("transform", "translate(0, " + (surLayout.yScale(0)) + ")")
                    .call(surLayout.xAxis)
                    .selectAll("text")
                    .style("text-anchor", function(d, i) { return (i === 0) ? "start" : "center"; });

                surSvg.selectAll(".survival-line").remove();

                for (var i = 0; i < genes.length; i++) {
                    var gene = genes[i];
                    surSvg.append("path")
                        .datum(gene.survival.compute)
                        .attr("class", "survival-line")
                        .style("stroke", gene.color)
                        .attr("d", lineFunction);
                }

            };

        }
    }

})();