package main

import (
	"fmt"

	"example.com/svc/pkg/store"
)

func main() {
	s := store.New()
	s.Put("k")
	fmt.Println(helper())
}

func helper() string {
	return "x"
}
