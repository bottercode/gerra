package main

import (
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"math"
	"os"
	"slices"
	"testing"
)

// Checks the port's JavaScript semantics against what Node itself does (testdata/js-fixtures.json,
// written by testdata/gen-fixtures.mjs).

type fixtures struct {
	ParseErrors []struct {
		Input string  `json:"input"`
		Error *string `json:"error"`
	} `json:"parseErrors"`
	Numbers []struct {
		Bits   string `json:"bits"`
		String string `json:"string"`
	} `json:"numbers"`
	NumberStrings []struct {
		Input  string `json:"input"`
		Number string `json:"number"`
	} `json:"numberStrings"`
	SortedWords []string `json:"sortedWords"`
	Inflection  []struct {
		Word     string `json:"word"`
		Plural   string `json:"plural"`
		Singular string `json:"singular"`
	} `json:"inflection"`
}

func loadFixtures(t *testing.T) fixtures {
	t.Helper()
	raw, err := os.ReadFile("testdata/js-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var f fixtures
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestParseErrorsMatchV8(t *testing.T) {
	for _, c := range loadFixtures(t).ParseErrors {
		_, err := parseJSON(c.Input)
		got := ""
		if err != nil {
			got = err.Error()
		}
		want := ""
		if c.Error != nil {
			want = *c.Error
		}
		if got != want {
			t.Errorf("JSON.parse(%q):\n  node: %s\n  go:   %s", c.Input, want, got)
		}
	}
}

func TestNumberToStringMatchesNode(t *testing.T) {
	for _, c := range loadFixtures(t).Numbers {
		b, _ := hex.DecodeString(c.Bits)
		f := math.Float64frombits(binary.LittleEndian.Uint64(b))
		if got := numberToString(f); got != c.String {
			t.Errorf("String(%v): node %s, go %s", f, c.String, got)
		}
	}
}

func TestStringToNumberMatchesNode(t *testing.T) {
	for _, c := range loadFixtures(t).NumberStrings {
		if got := numberToString(stringToNumber(c.Input)); got != c.Number {
			t.Errorf("Number(%q): node %s, go %s", c.Input, c.Number, got)
		}
	}
}

func TestLocaleCompareOrderMatchesNode(t *testing.T) {
	want := loadFixtures(t).SortedWords
	got := slices.Clone(want)
	slices.Reverse(got)
	slices.SortStableFunc(got, localeCompare)
	if !slices.Equal(got, want) {
		t.Errorf("localeCompare order:\n  node: %q\n  go:   %q", want, got)
	}
}

func TestInflectionMatchesNode(t *testing.T) {
	for _, c := range loadFixtures(t).Inflection {
		if got := pluralize(c.Word); got != c.Plural {
			t.Errorf("pluralize(%q): node %q, go %q", c.Word, c.Plural, got)
		}
		if got := singularize(c.Word); got != c.Singular {
			t.Errorf("singularize(%q): node %q, go %q", c.Word, c.Singular, got)
		}
	}
}

func TestStringifyMatchesJSONStringify(t *testing.T) {
	v, err := parseJSON(`{"b":1,"2":"two","a":[1.5,null,"x\u0001\"\\ é"],"1":{},"e":[],"n":-0}`)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := stringify(v)
	// node -e 'console.log(JSON.stringify(JSON.parse(String.raw`…`), null, 2))'
	want := "{\n  \"1\": {},\n  \"2\": \"two\",\n  \"b\": 1,\n  \"a\": [\n    1.5,\n    null,\n    \"x\\u0001\\\"\\\\ é\"\n  ],\n  \"e\": [],\n  \"n\": 0\n}"
	if string(got) != want {
		t.Errorf("stringify:\n got: %s\nwant: %s", got, want)
	}
}
