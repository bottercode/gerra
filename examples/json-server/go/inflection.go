package main

import (
	"regexp"
	"strings"
)

// A port of the `inflection` package's pluralize/singularize, which json-server uses to resolve
// `_embed` (post → posts, comments → comment). The rule tables are generated from the JS source.
type inflectionRule struct {
	re          *regexp.Regexp
	replace     bool
	replacement string
}

func applyRules(s string, rules []inflectionRule) string {
	if uncountableWords[strings.ToLower(s)] {
		return s
	}
	for _, r := range rules {
		if r.re.MatchString(s) {
			if r.replace {
				return r.re.ReplaceAllString(s, r.replacement)
			}
			return s
		}
	}
	return s
}

func pluralize(s string) string   { return applyRules(s, pluralRules) }
func singularize(s string) string { return applyRules(s, singularRules) }
