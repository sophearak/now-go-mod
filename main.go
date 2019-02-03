package main

import (
	now "github.com/zeit/now-builders/utils/go/bridge"
	"net/http"
)

func main() {
	now.Start(http.HandlerFunc(__NOW_HANDLER_FUNC_NAME))
}
